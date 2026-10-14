// WebGPU pipeline: source -> YCbCr -> FSRCNNX luma hooks -> optional CAS ->
// scaled composite on the overlay canvas.
//
// Work is split in two stages: process() runs the network once per source
// frame, composite() only redraws the canvas. Layout changes and A/B dragging
// re-composite without re-running the network. Both stages record into one
// command encoder that composite() submits.
(() => {
  const FSRX = (globalThis.FSRX ??= {});
  const { getGpu, watchGpu, createRenderPipeline, GpuTimer } = FSRX.gpu;
  const { CONVERT, SHARPEN, COMPOSITE } = FSRX.wgslPasses;
  const { translateHookPass, uniformLayout } = FSRX.wgslHook;
  const { evalRpn } = FSRX.mpvHook;

  const SCALER_IDS = { bilinear: 0, 'catmull-rom': 1 };
  // At most two physical targets per texture name: the second is needed only
  // when a pass reads and writes the same name (e.g. HOOKED LUMA).
  const MAX_TARGETS_PER_NAME = 2;
  const LUMA = 'LUMA';
  // LUMA is single-channel in mpv; r16float halves its VRAM (largest target at
  // 2x output). Feature maps keep four channels.
  const LUMA_FORMAT = 'r16float';
  const FEATURE_FORMAT = 'rgba16float';
  const SOURCE_FORMAT = 'rgba8unorm';
  // Source textures seen by the convert pass: the interpolator's frame pool
  // (7), its output texture and the video upload texture, plus slack. Past
  // this many the bind group cache is rebuilt from scratch.
  const MAX_CACHED_SOURCES = 10;
  // Bind groups kept per pass. Real and interpolated frames alternate between
  // two YCbCr targets, so every pass sees two input sets in steady state.
  const BIND_GROUP_VARIANTS = 2;
  const SIZE_NAMES = ['MAIN', 'NATIVE', 'CHROMA'];

  const formatFor = (name) => (name === LUMA ? LUMA_FORMAT : FEATURE_FORMAT);

  /** Float render target, reallocated only when its size changes. */
  class RenderTarget {
    /**
     * @param {GPUDevice} device
     * @param {GPUTextureFormat} format
     * @param {string} label
     */
    constructor(device, format, label) {
      this.device = device;
      this.format = format;
      this.label = label;
      this.w = 0;
      this.h = 0;
      /** @type {GPUTexture | null} */
      this.texture = null;
      this.view = null;
    }

    resize(w, h) {
      if (w === this.w && h === this.h) return;
      this.texture?.destroy();
      this.texture = this.device.createTexture({
        label: this.label,
        size: [w, h],
        format: this.format,
        // GPU* globals exist only in secure contexts, so they are read lazily.
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.view = this.texture.createView();
      this.w = w;
      this.h = h;
    }

    destroy() {
      this.texture?.destroy();
      this.texture = null;
    }
  }

  /**
   * Small cache of bind groups keyed by the identities of their textures; an
   * entry is rebuilt only when a texture was reallocated or a new input set
   * appears. Comparing identities keeps the steady state allocation-free.
   */
  class CachedBindGroup {
    constructor(device, layout, fixedEntries) {
      this.device = device;
      this.layout = layout;
      this.fixedEntries = fixedEntries;
      /** @type {Array<{textures: GPUTexture[], group: GPUBindGroup}>} */
      this.variants = [];
      this.nextVictim = 0;
    }

    /** @param {Array<RenderTarget>} targets - bound from binding fixedEntries.length on */
    get(targets) {
      for (const variant of this.variants) {
        if (matches(variant.textures, targets)) return variant.group;
      }
      const base = this.fixedEntries.length;
      const variant = {
        textures: targets.map((t) => t.texture),
        group: this.device.createBindGroup({
          layout: this.layout,
          entries: [
            ...this.fixedEntries,
            ...targets.map((t, i) => ({ binding: base + i, resource: t.view })),
          ],
        }),
      };
      if (this.variants.length < BIND_GROUP_VARIANTS) {
        this.variants.push(variant);
      } else {
        this.variants[this.nextVictim] = variant;
        this.nextVictim = (this.nextVictim + 1) % BIND_GROUP_VARIANTS;
      }
      return variant.group;
    }
  }

  function matches(textures, targets) {
    if (textures.length !== targets.length) return false;
    for (let i = 0; i < targets.length; i++) {
      if (textures[i] !== targets[i].texture) return false;
    }
    return true;
  }

  class Renderer {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{onFatal: (err: Error) => void}} callbacks - device loss or a GPU
     *   validation error; the renderer is unusable afterwards
     */
    constructor(canvas, { onFatal }) {
      this.canvas = canvas;
      this.onFatal = onFatal;
      this.gpu = null;
      this.device = null;
      this.context = null;
      this.gpuName = 'Unknown GPU';
      this.maxTextureSize = 0;
      /** @type {Map<string, RenderTarget[]>} */
      this.targetPool = new Map();
      /** @type {Map<string, Promise<{passes: Array<object>}>>} in-flight or compiled */
      this.models = new Map();
      /** Texture bindings of the current frame, reused to avoid per-frame allocation. */
      this.bound = new Map();
      this.inputs = [];
      this.usedNames = new Set();
      this.fixedSizes = { OUTPUT: { w: 0, h: 0 }, MAIN: { w: 0, h: 0 }, NATIVE: { w: 0, h: 0 }, CHROMA: { w: 0, h: 0 } };
      this.sizeOf = (name) => {
        const target = this.bound.get(name === 'HOOKED' ? LUMA : name);
        return target ? { w: target.w, h: target.h } : this.fixedSizes[name];
      };
      this.processed = null;
      /** Reused result object of process(). */
      this.result = { luma: null, yuv: null, modelApplied: false, lumaW: 0, lumaH: 0 };
      this.frameIndex = 0;
      this.builtins = null;
      this.encoder = null;
      this.measuring = false;
      this.timer = null;
      this.unwatch = null;
      this.destroyed = false;
      this.uploadTexture = null;
      this.sourceView = new Map();
    }

    /** Acquires the shared device and compiles the built-in passes. */
    async init() {
      const gpu = await getGpu();
      if (this.destroyed) return;
      this.gpu = gpu;
      this.device = gpu.device;
      this.unwatch = watchGpu(this.onFatal);
      this.gpuName = gpu.name;
      this.maxTextureSize = this.device.limits.maxTextureDimension2D;
      this.timer = new GpuTimer(gpu);
      this.context = this.canvas.getContext('webgpu');
      if (!this.context) throw new Error('Не удалось создать холст WebGPU');
      this.context.configure({ device: this.device, format: gpu.format, alphaMode: 'opaque' });

      const { device } = this;
      this.sampler = device.createSampler({
        magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
      });
      this.layouts = new Map();
      this.yuvReal = new RenderTarget(device, FEATURE_FORMAT, 'yuv-real');
      this.yuvMid = new RenderTarget(device, FEATURE_FORMAT, 'yuv-mid');
      this.sharpenParams = new Float32Array(4);
      this.compositeParams = new Float32Array(12);
      this.sharpenBuffer = this.uniformBuffer(this.sharpenParams.byteLength, 'sharpen');
      this.compositeBuffer = this.uniformBuffer(this.compositeParams.byteLength, 'composite');

      const convertLayout = this.bindLayout(0, 1);
      const sharpenLayout = this.bindLayout(1, 1);
      const compositeLayout = this.bindLayout(1, 3);
      const [convert, sharpen, composite] = await Promise.all([
        createRenderPipeline(device, { label: 'convert', code: CONVERT, layout: convertLayout.pipeline, format: FEATURE_FORMAT }),
        createRenderPipeline(device, { label: 'sharpen', code: SHARPEN, layout: sharpenLayout.pipeline, format: LUMA_FORMAT }),
        createRenderPipeline(device, { label: 'composite', code: COMPOSITE, layout: compositeLayout.pipeline, format: gpu.format }),
      ]);
      if (this.destroyed) return;
      this.builtins = {
        convert: { pipeline: convert, layout: convertLayout.group },
        sharpen: {
          pipeline: sharpen,
          binds: new CachedBindGroup(device, sharpenLayout.group, this.fixedEntries(this.sharpenBuffer)),
        },
        composite: {
          pipeline: composite,
          binds: new CachedBindGroup(device, compositeLayout.group, this.fixedEntries(this.compositeBuffer)),
        },
      };
    }

    uniformBuffer(size, label) {
      return this.device.createBuffer({
        label,
        size: Math.ceil(size / 16) * 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    /** Uniform buffer (when given) and the sampler, the leading entries of every pass. */
    fixedEntries(buffer) {
      const entries = buffer ? [{ binding: 0, resource: { buffer } }] : [];
      entries.push({ binding: entries.length, resource: this.sampler });
      return entries;
    }

    /**
     * Explicit layouts (not 'auto'), so bindings a shader happens not to use
     * are still valid in the bind group.
     * @param {0 | 1} uniforms
     * @param {number} textures
     */
    bindLayout(uniforms, textures) {
      const key = `${uniforms}:${textures}`;
      if (!this.layouts.has(key)) {
        const entries = [];
        const visibility = GPUShaderStage.FRAGMENT;
        if (uniforms) entries.push({ binding: 0, visibility, buffer: { type: 'uniform' } });
        entries.push({ binding: entries.length, visibility, sampler: { type: 'filtering' } });
        for (let i = 0; i < textures; i++) {
          entries.push({ binding: entries.length, visibility, texture: { sampleType: 'float' } });
        }
        const group = this.device.createBindGroupLayout({ entries });
        this.layouts.set(key, { group, pipeline: this.device.createPipelineLayout({ bindGroupLayouts: [group] }) });
      }
      return this.layouts.get(key);
    }

    /**
     * Compiles all passes of a parsed mpv hook shader. Concurrent calls for the
     * same id share one compilation.
     * @param {string} modelId
     * @param {Array<object>} hookPasses
     */
    loadModel(modelId, hookPasses) {
      if (!this.models.has(modelId)) {
        const pending = this.compileModel(hookPasses);
        // A failed compile must not poison the cache for a later retry.
        pending.catch(() => this.models.delete(modelId));
        this.models.set(modelId, pending);
      }
      return this.models.get(modelId);
    }

    async compileModel(hookPasses) {
      const { device } = this;
      const translated = hookPasses.map(translateHookPass);
      const pipelines = await Promise.all(translated.map((t, i) => createRenderPipeline(device, {
        label: hookPasses[i].desc || `pass ${i + 1}`,
        code: t.code,
        layout: this.bindLayout(1, t.textures.length).pipeline,
        format: formatFor(hookPasses[i].save || LUMA),
      })));
      const passes = hookPasses.map((pass, i) => {
        const { textures } = translated[i];
        const layout = uniformLayout(textures.length);
        const params = new Float32Array(layout.floats);
        const buffer = this.uniformBuffer(params.byteLength, pass.desc);
        return {
          ...pass,
          pipeline: pipelines[i],
          saveName: pass.save || LUMA,
          resizes: Boolean(pass.width || pass.height),
          textures,
          layout,
          params,
          frameView: new Int32Array(params.buffer),
          buffer,
          binds: new CachedBindGroup(device, this.bindLayout(1, textures.length).group, this.fixedEntries(buffer)),
        };
      });
      return { passes };
    }

    /**
     * Copies the current video frame into a renderer-owned texture.
     * Throws SecurityError for cross-origin videos without CORS; callers report it.
     * @param {HTMLVideoElement | HTMLCanvasElement} video
     * @returns {GPUTexture}
     */
    uploadVideo(video) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!this.uploadTexture || this.uploadTexture.width !== w || this.uploadTexture.height !== h) {
        this.uploadTexture?.destroy();
        this.uploadTexture = createSourceTexture(this.device, w, h, 'upload');
      }
      this.device.queue.copyExternalImageToTexture({ source: video }, { texture: this.uploadTexture }, [w, h]);
      return this.uploadTexture;
    }

    /**
     * Runs the network on a source frame.
     * @param {GPUTexture} source - any size; resampled to `srcW`×`srcH`
     * @param {{w: number, h: number}} output - full displayed frame size in
     *   device pixels (mpv's OUTPUT), used by WHEN conditions
     * @param {{passes: Array<object>} | null} model - compiled model or null to bypass
     * @param {number} sharpness
     * @param {{srcW: number, srcH: number, real?: boolean}} frame - source size;
     *   `real: false` marks an interpolated frame, which A/B never shows as original
     * @returns {{modelApplied: boolean, lumaW: number, lumaH: number}}
     */
    process(source, output, model, sharpness, { srcW, srcH, real = true }) {
      const encoder = this.beginFrame();
      try {
        const yuv = real ? this.yuvReal : this.yuvMid;
        yuv.resize(srcW, srcH);
        this.drawConvert(encoder, source, yuv);

        this.bound.clear();
        this.bound.set(LUMA, yuv);
        this.usedNames.clear();
        const modelApplied = model ? this.runHooks(encoder, model.passes, output, yuv) : false;
        if (sharpness > 0) this.drawSharpen(encoder, sharpness);
        this.trimPool();

        const luma = this.bound.get(LUMA);
        const { result } = this;
        result.luma = luma;
        result.yuv = yuv;
        result.modelApplied = modelApplied;
        result.lumaW = luma.w;
        result.lumaH = luma.h;
        this.processed = result;
        this.frameIndex++;
        return this.processed;
      } catch (err) {
        this.abortFrame();
        throw err;
      }
    }

    /**
     * Draws the last processed frame onto the canvas and submits the frame.
     * @param {{outW: number, outH: number, crop: {x: number, y: number, w: number, h: number}}} layout
     * @param {{antiring: number, scaler: string, split: number}} options
     */
    composite(layout, options) {
      if (!this.processed) return;
      const encoder = this.beginFrame();
      try {
        const { luma, yuv } = this.processed;
        // Before the first real frame (or after a resize) fall back to the current one.
        const original = this.yuvReal.w === yuv.w && this.yuvReal.h === yuv.h ? this.yuvReal : yuv;
        const { crop } = layout;
        const p = this.compositeParams;
        p[0] = luma.w; p[1] = luma.h;
        p[2] = yuv.w; p[3] = yuv.h;
        p[4] = crop.x; p[5] = crop.y; p[6] = crop.w; p[7] = crop.h;
        p[8] = options.antiring;
        p[9] = options.split;
        p[10] = SCALER_IDS[options.scaler] ?? 0;
        this.device.queue.writeBuffer(this.compositeBuffer, 0, p);
        this.inputs.length = 0;
        this.inputs.push(luma, yuv, original);
        const { pipeline, binds } = this.builtins.composite;
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: this.context.getCurrentTexture().createView(),
            loadOp: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            storeOp: 'store',
          }],
          timestampWrites: this.timer.passWrites(false, this.measuring),
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, binds.get(this.inputs));
        pass.draw(3);
        pass.end();
        this.submitFrame();
      } catch (err) {
        this.abortFrame();
        throw err;
      }
    }

    /** Smoothed GPU time of process + composite frames, in ms (0 = no sample yet). */
    get gpuMs() {
      return this.timer?.ms ?? 0;
    }

    beginFrame() {
      if (!this.encoder) {
        this.encoder = this.device.createCommandEncoder();
        this.measuring = false;
        this.firstPass = true;
      }
      return this.encoder;
    }

    /** Timestamp writes for a render pass of process(); the first one starts the measurement. */
    processPassWrites() {
      if (this.firstPass) {
        this.firstPass = false;
        this.measuring = this.timer.begin();
        return this.timer.passWrites(true, false);
      }
      return undefined;
    }

    submitFrame() {
      if (this.measuring) this.timer.resolve(this.encoder);
      this.device.queue.submit([this.encoder.finish()]);
      if (this.measuring) this.timer.submitted();
      this.encoder = null;
      this.measuring = false;
    }

    abortFrame() {
      if (this.measuring) this.timer.abort();
      this.encoder = null;
      this.measuring = false;
    }

    renderPass(encoder, target) {
      return encoder.beginRenderPass({
        colorAttachments: [{ view: target.view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
        timestampWrites: this.processPassWrites(),
      });
    }

    drawConvert(encoder, source, target) {
      const { pipeline, layout } = this.builtins.convert;
      let group = this.sourceView.get(source);
      if (!group) {
        if (this.sourceView.size >= MAX_CACHED_SOURCES) this.sourceView.clear();
        group = this.device.createBindGroup({
          layout,
          entries: [...this.fixedEntries(null), { binding: 1, resource: source.createView() }],
        });
        this.sourceView.set(source, group);
      }
      const pass = this.renderPass(encoder, target);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }

    /**
     * Executes the mpv hook passes, updating `this.bound` with saved textures.
     * @returns {boolean} whether the resizing pass ran
     */
    runHooks(encoder, passes, output, yuv) {
      const { bound, inputs, fixedSizes, sizeOf } = this;
      fixedSizes.OUTPUT.w = output.w;
      fixedSizes.OUTPUT.h = output.h;
      for (const key of SIZE_NAMES) {
        fixedSizes[key].w = yuv.w;
        fixedSizes[key].h = yuv.h;
      }
      let applied = false;

      for (const pass of passes) {
        if (pass.when && !evalRpn(pass.when, sizeOf)) continue;
        const hooked = bound.get(LUMA);
        const outW = Math.round(pass.width ? evalRpn(pass.width, sizeOf) : hooked.w);
        const outH = Math.round(pass.height ? evalRpn(pass.height, sizeOf) : hooked.h);
        if (outW > this.maxTextureSize || outH > this.maxTextureSize) {
          // Too large for this GPU: fall back to plain scaling of the source.
          bound.set(LUMA, yuv);
          return false;
        }

        inputs.length = 0;
        for (const name of pass.textures) {
          const tex = bound.get(name);
          if (!tex) throw new Error(`Проход «${pass.desc}» использует неизвестную текстуру`);
          inputs.push(tex);
        }
        this.writeHookParams(pass, inputs, output, yuv);
        const target = this.acquireTarget(pass.saveName, outW, outH, inputs);
        const renderPass = this.renderPass(encoder, target);
        renderPass.setPipeline(pass.pipeline);
        renderPass.setBindGroup(0, pass.binds.get(inputs));
        renderPass.draw(3);
        renderPass.end();
        bound.set(pass.saveName, target);
        if (pass.resizes) applied = true;
      }
      return applied;
    }

    writeHookParams(pass, inputs, output, yuv) {
      const { params, layout, frameView } = pass;
      inputs.forEach((tex, i) => {
        const o = layout.textureOffset(i);
        params[o] = tex.w;
        params[o + 1] = tex.h;
        params[o + 2] = 1 / tex.w;
        params[o + 3] = 1 / tex.h;
      });
      params[layout.inputSize] = yuv.w;
      params[layout.inputSize + 1] = yuv.h;
      params[layout.targetSize] = output.w;
      params[layout.targetSize + 1] = output.h;
      frameView[layout.frame] = this.frameIndex;
      this.device.queue.writeBuffer(pass.buffer, 0, params);
    }

    /** Picks a pooled target for `name` that is not being read in this pass. */
    acquireTarget(name, w, h, inputs) {
      this.usedNames.add(name);
      const pool = this.targetPool.get(name) ?? [];
      let target = pool.find((t) => !inputs.includes(t));
      if (!target) {
        if (pool.length >= MAX_TARGETS_PER_NAME) throw new Error(`Не хватает текстур для ${name}`);
        target = new RenderTarget(this.device, formatFor(name), name);
        pool.push(target);
        this.targetPool.set(name, pool);
      }
      target.resize(w, h);
      return target;
    }

    /** Frees targets the last frame did not touch (model switch, bypass). */
    trimPool() {
      for (const [name, pool] of this.targetPool) {
        if (this.usedNames.has(name)) continue;
        pool.forEach((t) => t.destroy());
        this.targetPool.delete(name);
      }
    }

    drawSharpen(encoder, sharpness) {
      const { pipeline, binds } = this.builtins.sharpen;
      const luma = this.bound.get(LUMA);
      this.inputs.length = 0;
      this.inputs.push(luma);
      const target = this.acquireTarget(LUMA, luma.w, luma.h, this.inputs);
      const p = this.sharpenParams;
      p[0] = 1 / luma.w;
      p[1] = 1 / luma.h;
      p[2] = sharpness;
      this.device.queue.writeBuffer(this.sharpenBuffer, 0, p);
      const pass = this.renderPass(encoder, target);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, binds.get(this.inputs));
      pass.draw(3);
      pass.end();
      this.bound.set(LUMA, target);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.processed = null;
      this.encoder = null;
      this.unwatch?.();
      if (!this.device) return;
      for (const pool of this.targetPool.values()) pool.forEach((t) => t.destroy());
      this.targetPool.clear();
      for (const pending of this.models.values()) {
        pending
          .then(({ passes }) => passes.forEach((pass) => pass.buffer.destroy()))
          .catch(() => { /* compile failure was already reported by the session */ });
      }
      this.models.clear();
      this.sourceView.clear();
      this.yuvReal?.destroy();
      this.yuvMid?.destroy();
      this.uploadTexture?.destroy();
      this.sharpenBuffer?.destroy();
      this.compositeBuffer?.destroy();
      this.timer?.destroy();
      // The shared device stays alive for other sessions and the interpolator.
      this.context?.unconfigure();
    }
  }

  /**
   * rgba8 texture that can receive video frames and be sampled.
   * @param {GPUDevice} device
   */
  function createSourceTexture(device, w, h, label) {
    return device.createTexture({
      label,
      size: [w, h],
      format: SOURCE_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  FSRX.Renderer = Renderer;
  FSRX.createSourceTexture = createSourceTexture;
})();
