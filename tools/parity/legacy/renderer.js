// WebGL2 pipeline: video -> YCbCr -> FSRCNNX luma hooks -> optional CAS ->
// scaled composite on the overlay canvas.
//
// Work is split in two stages: process() runs the network once per video
// frame, composite() only redraws the canvas. Layout changes and A/B dragging
// re-composite without re-running the network.
(() => {
  const FSRX = (globalThis.FSRX ??= {});
  const { buildPrograms, uniformLocator, RenderTarget, createTexture } = FSRX.gl;
  const { CONVERT_FS, SHARPEN_FS, OUTPUT_FS, wrapHookPass } = FSRX.shaders;
  const { evalRpn } = FSRX.mpvHook;

  const SCALER_IDS = { bilinear: 0, 'catmull-rom': 1 };
  // At most two physical targets per texture name: the second is needed only
  // when a pass reads and writes the same name (e.g. HOOKED LUMA).
  const MAX_TARGETS_PER_NAME = 2;
  const LUMA = 'LUMA';

  class Renderer {
    /** @param {HTMLCanvasElement} canvas */
    constructor(canvas) {
      const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      });
      if (!gl) throw new Error('WebGL2 is not available (hardware acceleration disabled?)');
      if (!gl.getExtension('EXT_color_buffer_float')) {
        throw new Error('GPU does not support float render targets (EXT_color_buffer_float)');
      }
      this.gl = gl;
      this.gpuName = String(gl.getParameter(gl.RENDERER) || 'Unknown GPU');
      this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      this.vao = gl.createVertexArray();
      this.srcTexture = createTexture(gl);
      this.yuvTarget = new RenderTarget(gl);
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
      this.frameIndex = 0;
      this.builtins = null;
    }

    /** Compiles the built-in passes; must finish before the first render. */
    async init() {
      const [convert, sharpen, output] = await buildPrograms(this.gl, [
        { label: 'convert', fragment: CONVERT_FS },
        { label: 'sharpen', fragment: SHARPEN_FS },
        { label: 'output', fragment: OUTPUT_FS },
      ]);
      this.builtins = {
        convert: { program: convert, loc: uniformLocator(this.gl, convert) },
        sharpen: { program: sharpen, loc: uniformLocator(this.gl, sharpen) },
        output: { program: output, loc: uniformLocator(this.gl, output) },
      };
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
      const { gl } = this;
      const wrapped = hookPasses.map(wrapHookPass);
      const programs = await buildPrograms(gl, wrapped.map((w, i) => ({
        label: hookPasses[i].desc || `pass ${i + 1}`,
        fragment: w.fragment,
      })));
      const passes = hookPasses.map((pass, i) => {
        const loc = uniformLocator(gl, programs[i]);
        return {
          ...pass,
          program: programs[i],
          saveName: pass.save || LUMA,
          resizes: Boolean(pass.width || pass.height),
          samplers: wrapped[i].textures.map((name) => ({
            name,
            raw: loc(`${name}_raw`),
            size: loc(`${name}_size`),
            pt: loc(`${name}_pt`),
          })),
          inputSize: loc('input_size'),
          targetSize: loc('target_size'),
          frame: loc('frame'),
        };
      });
      return { passes };
    }

    /**
     * Uploads the current video frame and runs the network.
     * @param {HTMLVideoElement} video
     * @param {{w: number, h: number}} output - full displayed frame size in
     *   device pixels (mpv's OUTPUT), used by WHEN conditions
     * @param {{passes: Array<object>} | null} model - compiled model or null to bypass
     * @param {number} sharpness
     * @returns {{modelApplied: boolean, lumaW: number, lumaH: number}}
     */
    process(video, output, model, sharpness) {
      const { gl } = this;
      const srcW = video.videoWidth;
      const srcH = video.videoHeight;
      gl.bindVertexArray(this.vao);
      gl.disable(gl.BLEND);

      this.uploadFrame(video);
      this.yuvTarget.resize(srcW, srcH);
      this.drawConvert(srcW, srcH);

      this.bound.clear();
      this.bound.set(LUMA, this.yuvTarget);
      this.usedNames.clear();
      const modelApplied = model ? this.runHooks(model.passes, output, srcW, srcH) : false;
      if (sharpness > 0) this.drawSharpen(sharpness);
      this.trimPool();

      const luma = this.bound.get(LUMA);
      this.processed = { luma, modelApplied, lumaW: luma.w, lumaH: luma.h };
      this.frameIndex++;
      return this.processed;
    }

    /**
     * Draws the last processed frame onto the canvas.
     * @param {{outW: number, outH: number, crop: {x: number, y: number, w: number, h: number}}} layout
     * @param {{antiring: number, scaler: string, split: number}} options
     */
    composite(layout, options) {
      if (!this.processed) return;
      const { gl } = this;
      const { program, loc } = this.builtins.output;
      const { luma } = this.processed;
      const { crop } = layout;
      gl.bindVertexArray(this.vao);
      gl.useProgram(program);
      this.bindTexture(0, luma.texture, loc('u_luma'));
      this.bindTexture(1, this.yuvTarget.texture, loc('u_yuv'));
      gl.uniform2f(loc('u_lumaSize'), luma.w, luma.h);
      gl.uniform2f(loc('u_srcSize'), this.yuvTarget.w, this.yuvTarget.h);
      gl.uniform1f(loc('u_antiring'), options.antiring);
      gl.uniform4f(loc('u_crop'), crop.x, crop.y, crop.w, crop.h);
      gl.uniform1f(loc('u_split'), options.split);
      gl.uniform1i(loc('u_scaler'), SCALER_IDS[options.scaler] ?? 0);
      this.drawTo(null, layout.outW, layout.outH);
    }

    uploadFrame(video) {
      const { gl } = this;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      // Throws SecurityError for cross-origin videos without CORS; callers report it.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }

    drawConvert(w, h) {
      const { program, loc } = this.builtins.convert;
      this.gl.useProgram(program);
      this.bindTexture(0, this.srcTexture, loc('u_src'));
      this.drawTo(this.yuvTarget.framebuffer, w, h);
    }

    /**
     * Executes the mpv hook passes, updating `this.bound` with saved textures.
     * @returns {boolean} whether the resizing pass ran
     */
    runHooks(passes, output, srcW, srcH) {
      const { gl, bound, inputs, fixedSizes, sizeOf } = this;
      fixedSizes.OUTPUT.w = output.w;
      fixedSizes.OUTPUT.h = output.h;
      for (const key of ['MAIN', 'NATIVE', 'CHROMA']) {
        fixedSizes[key].w = srcW;
        fixedSizes[key].h = srcH;
      }
      let applied = false;

      for (const pass of passes) {
        if (pass.when && !evalRpn(pass.when, sizeOf)) continue;
        const hooked = bound.get(LUMA);
        const outW = Math.round(pass.width ? evalRpn(pass.width, sizeOf) : hooked.w);
        const outH = Math.round(pass.height ? evalRpn(pass.height, sizeOf) : hooked.h);
        if (outW > this.maxTextureSize || outH > this.maxTextureSize) {
          // Too large for this GPU: fall back to plain scaling of the source.
          bound.set(LUMA, this.yuvTarget);
          return false;
        }

        inputs.length = 0;
        for (const sampler of pass.samplers) {
          const tex = bound.get(sampler.name);
          if (!tex) throw new Error(`Pass "${pass.desc}" binds an unknown texture`);
          inputs.push(tex);
        }
        const target = this.acquireTarget(pass.saveName, outW, outH, inputs);
        gl.useProgram(pass.program);
        pass.samplers.forEach((sampler, unit) => {
          const tex = inputs[unit];
          this.bindTexture(unit, tex.texture, sampler.raw);
          gl.uniform2f(sampler.size, tex.w, tex.h);
          gl.uniform2f(sampler.pt, 1 / tex.w, 1 / tex.h);
        });
        gl.uniform2f(pass.inputSize, srcW, srcH);
        gl.uniform2f(pass.targetSize, output.w, output.h);
        gl.uniform1i(pass.frame, this.frameIndex);
        this.drawTo(target.framebuffer, outW, outH);
        bound.set(pass.saveName, target);
        if (pass.resizes) applied = true;
      }
      return applied;
    }

    /** Picks a pooled target for `name` that is not being read in this pass. */
    acquireTarget(name, w, h, inputs) {
      this.usedNames.add(name);
      const pool = this.targetPool.get(name) ?? [];
      let target = pool.find((t) => !inputs.includes(t));
      if (!target) {
        if (pool.length >= MAX_TARGETS_PER_NAME) throw new Error(`Texture pool exhausted for ${name}`);
        target = new RenderTarget(this.gl);
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

    drawSharpen(sharpness) {
      const { gl } = this;
      const { program, loc } = this.builtins.sharpen;
      const luma = this.bound.get(LUMA);
      this.inputs.length = 0;
      this.inputs.push(luma);
      const target = this.acquireTarget(LUMA, luma.w, luma.h, this.inputs);
      gl.useProgram(program);
      this.bindTexture(0, luma.texture, loc('u_luma'));
      gl.uniform2f(loc('u_pt'), 1 / luma.w, 1 / luma.h);
      gl.uniform1f(loc('u_sharpness'), sharpness);
      this.drawTo(target.framebuffer, luma.w, luma.h);
      this.bound.set(LUMA, target);
    }

    bindTexture(unit, texture, location) {
      const { gl } = this;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(location, unit);
    }

    drawTo(framebuffer, w, h) {
      const { gl } = this;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    destroy() {
      const { gl } = this;
      this.processed = null;
      if (gl.isContextLost()) return;
      for (const pool of this.targetPool.values()) pool.forEach((t) => t.destroy());
      this.targetPool.clear();
      for (const pending of this.models.values()) {
        pending
          .then(({ passes }) => passes.forEach((p) => gl.deleteProgram(p.program)))
          .catch(() => { /* compile failure was already reported by the session */ });
      }
      this.models.clear();
      if (this.builtins) Object.values(this.builtins).forEach((b) => gl.deleteProgram(b.program));
      this.yuvTarget.destroy();
      gl.deleteTexture(this.srcTexture);
      gl.deleteVertexArray(this.vao);
      // Frees the GPU context right away instead of waiting for GC.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }

  FSRX.Renderer = Renderer;
})();
