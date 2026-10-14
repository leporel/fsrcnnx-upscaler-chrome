// ×2 frame interpolation on the shared device: owns the pool of source-frame
// textures, the Framegen runtime and the output texture for in-between frames.
(() => {
  const FSRX = (globalThis.FSRX ??= {});
  const { loadFramegen, loadConvTune, runConvTune } = FSRX.framegen;
  const { scoped } = FSRX.gpu;
  const { FrameDiff, createSourceTexture } = FSRX;

  // Frames queued by the scheduler plus the comparison reference and one
  // being uploaded; FrameScheduler keeps fewer than this.
  const MAX_SLOTS = 7;
  // The runtime works on sizes divisible by 16; its sampler resamples any input.
  const MODEL_ALIGN = 16;
  // Kernel autotune runs when playback is paused, or after this long anyway
  // (one hiccup is worth up to ~20 % faster mids for the rest of the session).
  const TUNE_FORCE_AFTER_MS = 120000;
  const TUNE_POLL_MS = 3000;

  // Pixel budget of the network (1024x576 for 16:9), between upstream's 480p
  // default and 720p: a bit more detail than 480p while 720p/1080p sources
  // stay cheaper than at full size. Budgeting area rather than height keeps
  // the cost and quality the same for 21:9, 4:3 or vertical video. Motion in
  // pixels stays within what the small network estimates reliably, and with
  // the output larger than the model the runtime upsamples the flow guided by
  // image edges; at the model size it would use plain blocky flow instead.
  const MODEL_PIXELS = 1024 * 576;

  const alignUp = (v) => Math.ceil(v / MODEL_ALIGN) * MODEL_ALIGN;

  /**
   * Network size for a source: same aspect, at most MODEL_PIXELS, each side
   * divisible by 16 (the runtime scales flow per axis, so the rounding does
   * not distort motion).
   */
  function modelSize(srcW, srcH) {
    const scale = Math.min(1, Math.sqrt(MODEL_PIXELS / (srcW * srcH)));
    if (scale === 1) return { w: alignUp(srcW), h: alignUp(srcH) };
    const round16 = (v) => Math.max(MODEL_ALIGN, Math.round(v / MODEL_ALIGN) * MODEL_ALIGN);
    return { w: round16(srcW * scale), h: round16(srcH * scale) };
  }

  /**
   * @typedef {object} FrameSlot
   * @property {GPUTexture} texture - rgba8, source size
   * @property {number} id - stable per texture (bind group cache key)
   * @property {number} gen - bumped on every upload, so a reused texture is
   *   never mistaken for the pair the runtime already prepared
   * @property {number} refs
   */

  class Interpolator {
    /**
     * @param {{device: GPUDevice, name: string, hasTimestamps: boolean}} gpu
     * @param {{isIdle: () => boolean, onMeasure: (kind: 'prep' | 'run', ms: number) => void}} hooks
     */
    constructor(gpu, { isIdle, onMeasure }) {
      this.gpu = gpu;
      this.device = gpu.device;
      this.isIdle = isIdle;
      this.onMeasure = onMeasure;
      /** @type {FrameSlot[]} */
      this.pool = [];
      this.nextId = 1;
      this.gen = 0;
      this.srcW = 0;
      this.srcH = 0;
      this.rt = null;
      this.rtKey = '';
      this.buildKey = '';
      this.error = null;
      this.midTex = null;
      this.prev = null;
      this.prepA = -1;
      this.prepB = -1;
      this.diff = new FrameDiff(this.device);
      this.diffReady = this.diff.init();
      // Reported through build(), which awaits it; avoid an unhandled rejection before that.
      this.diffReady.catch(() => {});
      this.tuneTimer = 0;
      this.destroyed = false;
      this.recordPrep = (ms) => { if (Number.isFinite(ms)) this.onMeasure('prep', ms); };
      this.recordRun = (ms) => { if (Number.isFinite(ms)) this.onMeasure('run', ms); };
    }

    /** Whether mids can be produced for the current source size. */
    get ready() {
      return this.rt !== null && this.rtKey === this.sizeKey && this.diff.ready;
    }

    get modelSize() {
      return modelSize(this.srcW, this.srcH);
    }

    get sizeKey() {
      const { w, h } = this.modelSize;
      return `${w}x${h}`;
    }

    /** Bytes of textures owned here (the runtime's own buffers come on top). */
    get textureBytes() {
      const frame = this.srcW * this.srcH * 4;
      return frame * (this.pool.length + (this.midTex ? 1 : 0));
    }

    /**
     * Sets the source size; (re)builds the runtime in the background when it
     * changed. All frames must have been released by the caller beforehand.
     */
    setSourceSize(w, h) {
      if (w === this.srcW && h === this.srcH) {
        this.ensureRuntime();
        return;
      }
      this.srcW = w;
      this.srcH = h;
      this.dropPrev();
      this.pool = this.pool.filter((slot) => {
        if (slot.refs > 0) return true;
        slot.texture.destroy();
        return false;
      });
      this.diff.clearCache();
      this.midTex?.destroy();
      this.midTex = this.device.createTexture({
        label: 'interpolated',
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.prepA = -1;
      this.prepB = -1;
      this.ensureRuntime();
    }

    ensureRuntime() {
      const key = this.sizeKey;
      if (this.error || this.rtKey === key || this.buildKey === key) return;
      this.buildKey = key;
      const { w, h } = this.modelSize;
      this.build(w, h, key)
        .catch((err) => {
          if (this.buildKey === key) this.error = err;
        })
        .finally(() => {
          if (this.buildKey === key) this.buildKey = '';
        });
    }

    async build(w, h, key) {
      const [fg, tune] = await Promise.all([loadFramegen(), loadConvTune(this.gpu.name, w, h), this.diffReady]);
      if (this.destroyed || this.buildKey !== key) return;
      // A runtime build failure disables ×2 only (see InterpolationController).
      const rt = await scoped(this.device, () => fg.createRT(this.device, {
        w,
        h,
        weightsBin: fg.weightsBin,
        weightsManifest: fg.weightsManifest,
        textureInput: true,
        textureOutput: true,
        // Upstream's default: keeps static overlays burned into the video
        // (logos, subtitles, HUDs) from wobbling, for one extra full-res
        // difference pass per pair.
        staticGuard: true,
        convTune: tune,
      }));
      if (this.destroyed || this.buildKey !== key) {
        rt.destroy();
        return;
      }
      this.rt?.destroy();
      this.rt = rt;
      this.rtKey = key;
      this.prepA = -1;
      this.prepB = -1;
      if (!tune) this.scheduleTune(w, h);
    }

    scheduleTune(w, h) {
      clearTimeout(this.tuneTimer);
      const started = performance.now();
      const poll = () => {
        if (this.destroyed || this.rtKey !== `${w}x${h}`) return;
        if (!this.isIdle() && performance.now() - started < TUNE_FORCE_AFTER_MS) {
          this.tuneTimer = setTimeout(poll, TUNE_POLL_MS);
          return;
        }
        runConvTune(this.device, this.gpu.name, w, h).catch((err) => {
          // Optional speed-up: the untuned kernels keep working.
          console.warn('[FSRCNNX] frame generation autotune skipped', err);
        });
      };
      this.tuneTimer = setTimeout(poll, TUNE_POLL_MS);
    }

    /**
     * Copies the current video frame into a pooled texture and starts its
     * difference statistic against the previous frame.
     * @param {HTMLVideoElement} video
     * @param {object} target - passed through to onClass (see FrameDiff.compare)
     * @param {number} seq
     * @param {(target: object, seq: number, cls: 'dup' | 'motion' | 'cut') => void} onClass
     * @returns {FrameSlot | null} owned by the caller (release it); null when
     *   the pool is exhausted
     */
    pushFrame(video, target, seq, onClass) {
      let slot = this.pool.find((s) => s.refs === 0);
      if (!slot) {
        if (this.pool.length >= MAX_SLOTS) return null;
        slot = { texture: createSourceTexture(this.device, this.srcW, this.srcH, 'frame'), id: this.nextId++, gen: 0, refs: 0 };
        this.pool.push(slot);
      }
      // Throws SecurityError for cross-origin videos without CORS; callers report it.
      this.device.queue.copyExternalImageToTexture({ source: video }, { texture: slot.texture }, [this.srcW, this.srcH]);
      slot.gen = ++this.gen;
      slot.refs = 1;
      if (this.prev) this.diff.compare(this.prev, slot, target, seq, onClass);
      this.dropPrev();
      this.prev = slot;
      slot.refs++;
      return slot;
    }

    release(slot) {
      slot.refs--;
      if (slot.refs === 0 && (slot.texture.width !== this.srcW || slot.texture.height !== this.srcH)) {
        slot.texture.destroy();
        this.pool.splice(this.pool.indexOf(slot), 1);
      }
    }

    /** Forgets the comparison reference, e.g. after a seek. */
    dropPrev() {
      if (this.prev) this.release(this.prev);
      this.prev = null;
    }

    /**
     * Renders the frame at position t between a and b into the output texture.
     * Submits its own command buffers; queue order makes the result visible
     * to work submitted afterwards.
     * @param {FrameSlot} a
     * @param {FrameSlot} b
     * @param {number} t - 0..1
     * @returns {GPUTexture}
     */
    mid(a, b, t) {
      const measure = this.gpu.hasTimestamps;
      if (this.prepA !== a.gen || this.prepB !== b.gen) {
        // The trunk runs once per pair; each further t only reruns the head.
        this.rt.prepPair(a.texture, b.texture, { measure })?.then(this.recordPrep);
        this.prepA = a.gen;
        this.prepB = b.gen;
      }
      this.rt.runT(t, this.midTex, { measure })?.then(this.recordRun);
      return this.midTex;
    }

    destroy() {
      this.destroyed = true;
      clearTimeout(this.tuneTimer);
      this.rt?.destroy();
      this.rt = null;
      this.pool.forEach((slot) => slot.texture.destroy());
      this.pool.length = 0;
      this.prev = null;
      this.midTex?.destroy();
      this.diff.destroy();
    }
  }

  FSRX.Interpolator = Interpolator;
})();
