// WebGPU device shared by every session (and the frame interpolator) in this
// document, plus small helpers for pipeline creation and GPU timing.
(() => {
  const FSRX = (globalThis.FSRX ??= {});

  // Features that speed things up when present but are never required.
  const OPTIONAL_FEATURES = ['shader-f16', 'timestamp-query', 'subgroups'];
  // Readback slots for timestamp queries; when all are still mapping the
  // frame simply goes unmeasured instead of allocating more.
  const TIMER_SLOTS = 4;
  // Exponential smoothing factor for reported GPU times and budget averages.
  const TIME_SMOOTHING = 0.1;

  /** @type {Promise<object> | null} */
  let pending = null;
  let currentGpu = null;
  const lostListeners = new Set();
  const errorListeners = new Set();

  function describeAdapter(adapter) {
    const info = adapter.info ?? {};
    const name = info.description || [info.vendor, info.architecture].filter(Boolean).join(' ');
    return name || 'Unknown GPU';
  }

  async function requestGpu() {
    if (!window.isSecureContext) {
      throw new Error('WebGPU работает только на защищённых страницах (https)');
    }
    if (!navigator.gpu) {
      throw new Error('WebGPU недоступен: включите «Использовать графическое ускорение» в настройках Chrome');
    }
    // Chrome ignores powerPreference on Windows and logs a warning for it
    // (crbug.com/369219127); there the GPU is chosen in Windows graphics settings.
    const onWindows = navigator.userAgentData?.platform === 'Windows';
    const adapter = await navigator.gpu.requestAdapter(onWindows ? undefined : { powerPreference: 'high-performance' });
    if (!adapter) throw new Error('Видеокарта не найдена для WebGPU (она в чёрном списке Chrome или драйвер устарел)');
    const requiredFeatures = OPTIONAL_FEATURES.filter((f) => adapter.features.has(f));
    let device;
    try {
      device = await adapter.requestDevice({
        requiredFeatures,
        requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
      });
    } catch (err) {
      throw new Error(`Не удалось подключиться к видеокарте: ${FSRX.errorMessage(err)}`);
    }
    const gpu = {
      device,
      name: describeAdapter(adapter),
      format: navigator.gpu.getPreferredCanvasFormat(),
      hasTimestamps: device.features.has('timestamp-query'),
      hasF16: device.features.has('shader-f16'),
    };
    device.lost.then((info) => {
      // The next getGpu() starts over with a fresh device.
      if (pending && gpu === currentGpu) pending = null;
      currentGpu = null;
      const err = new Error(`Связь с видеокартой потеряна (сбой или обновление драйвера)${info.message ? `: ${info.message}` : ''}`);
      err.reason = info.reason;
      lostListeners.forEach((listener) => listener(err));
    });
    device.addEventListener('uncapturederror', (event) => {
      const err = new Error(`Ошибка видеокарты: ${event.error.message}`);
      console.error('[FSRCNNX]', err);
      errorListeners.forEach((listener) => listener(err));
    });
    currentGpu = gpu;
    return gpu;
  }

  /**
   * Lazily creates the shared device. A failed attempt is not cached, so a
   * later session retries (e.g. after the user re-enabled acceleration).
   * @returns {Promise<{device: GPUDevice, name: string, format: GPUTextureFormat,
   *   hasTimestamps: boolean, hasF16: boolean}>}
   */
  function getGpu() {
    if (!pending) {
      pending = requestGpu();
      pending.catch(() => { pending = null; });
    }
    return pending;
  }

  /**
   * Subscribes to device loss and uncaptured validation errors.
   * @param {(err: Error) => void} onFatal
   * @returns {() => void} unsubscribe
   */
  function watchGpu(onFatal) {
    lostListeners.add(onFatal);
    errorListeners.add(onFatal);
    return () => {
      lostListeners.delete(onFatal);
      errorListeners.delete(onFatal);
    };
  }

  /**
   * Compiles a shader module and an async render pipeline. Compile errors are
   * reported with the pass label and WGSL line numbers.
   * @param {GPUDevice} device
   * @param {{label: string, code: string, layout: GPUPipelineLayout,
   *   format: GPUTextureFormat, vertex?: string, fragment?: string}} desc
   */
  async function createRenderPipeline(device, { label, code, layout, format, vertex = 'vs', fragment = 'fs' }) {
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ label, code });
    const moduleError = device.popErrorScope();
    try {
      const pipeline = await device.createRenderPipelineAsync({
        label,
        layout,
        vertex: { module, entryPoint: vertex },
        fragment: { module, entryPoint: fragment, targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      const scopeError = await moduleError;
      if (scopeError) throw scopeError;
      return pipeline;
    } catch (err) {
      await moduleError;
      throw new Error(`Шейдер «${label}» не собрался: ${await compileErrors(module, err)}`);
    }
  }

  async function compileErrors(module, fallback) {
    const info = await module.getCompilationInfo();
    const lines = info.messages
      .filter((m) => m.type === 'error')
      .map((m) => `строка ${m.lineNum}:${m.linePos} ${m.message}`);
    return lines.length > 0 ? lines.join('; ') : FSRX.errorMessage(fallback);
  }

  /**
   * Compute counterpart of createRenderPipeline, with the same diagnostics.
   * @param {GPUDevice} device
   * @param {{label: string, code: string, entryPoint?: string}} desc
   */
  async function createComputePipeline(device, { label, code, entryPoint = 'main' }) {
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ label, code });
    const moduleError = device.popErrorScope();
    try {
      const pipeline = await device.createComputePipelineAsync({ label, layout: 'auto', compute: { module, entryPoint } });
      const scopeError = await moduleError;
      if (scopeError) throw scopeError;
      return pipeline;
    } catch (err) {
      await moduleError;
      throw new Error(`Шейдер «${label}» не собрался: ${await compileErrors(module, err)}`);
    }
  }

  /**
   * Runs async GPU work inside a validation error scope, so its errors reject
   * the returned promise instead of reaching the device-wide handler (which
   * ends the session). Errors of unrelated work that happens to be encoded
   * while `task` awaits land here too; only use it for optional work.
   * @template T
   * @param {GPUDevice} device
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  async function scoped(device, task) {
    device.pushErrorScope('validation');
    let result;
    try {
      result = await task();
    } finally {
      const error = await device.popErrorScope();
      if (error) throw new Error(`Ошибка видеокарты: ${error.message}`);
    }
    return result;
  }

  /** Exponential moving average with an unweighted first sample. */
  class Ema {
    constructor(alpha = TIME_SMOOTHING) {
      this.alpha = alpha;
      this.value = 0;
      this.samples = 0;
    }

    add(v) {
      this.value = this.samples === 0 ? v : this.value + (v - this.value) * this.alpha;
      this.samples++;
    }

    reset() {
      this.value = 0;
      this.samples = 0;
    }
  }

  /**
   * Measures GPU time of command sequences. Uses timestamp queries when the
   * device has them, otherwise wall time until queue.onSubmittedWorkDone()
   * (an upper bound that includes queueing delay).
   */
  class GpuTimer {
    /**
     * @param {{device: GPUDevice, hasTimestamps: boolean}} gpu
     * @param {{wall?: boolean}} [options] - wall: measure wall time even when
     *   timestamps exist (for spans covering several submits)
     */
    constructor(gpu, { wall = false } = {}) {
      this.device = gpu.device;
      this.time = new Ema();
      this.slots = [];
      this.slot = null;
      this.wallBusy = false;
      this.wallStart = 0;
      // Callbacks and timestampWrites descriptors are created once, not per frame.
      this.onWallDone = () => {
        this.wallBusy = false;
        this.time.add(performance.now() - this.wallStart);
      };
      this.onWallFailed = () => { this.wallBusy = false; };
      if (gpu.hasTimestamps && !wall) {
        for (let i = 0; i < TIMER_SLOTS; i++) this.slots.push(this.createSlot());
      }
    }

    createSlot() {
      const querySet = this.device.createQuerySet({ type: 'timestamp', count: 2 });
      const slot = {
        busy: false,
        querySet,
        resolve: this.device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        read: this.device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        writesFirst: { querySet, beginningOfPassWriteIndex: 0 },
        writesLast: { querySet, endOfPassWriteIndex: 1 },
        writesBoth: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
      };
      slot.onMapped = () => this.onMapped(slot);
      slot.onMapFailed = () => { slot.busy = false; };
      return slot;
    }

    /** Smoothed time in ms (0 until the first sample). */
    get ms() {
      return this.time.value;
    }

    get samples() {
      return this.time.samples;
    }

    get usesTimestamps() {
      return this.slots.length > 0;
    }

    /** Starts a measurement; returns false when every slot is still busy. */
    begin() {
      if (!this.usesTimestamps) {
        if (this.wallBusy) return false;
        this.wallBusy = true;
        this.wallStart = performance.now();
        this.slot = null;
        return true;
      }
      this.slot = this.slots.find((s) => !s.busy) ?? null;
      if (this.slot) this.slot.busy = true;
      return this.slot !== null;
    }

    /**
     * timestampWrites for a pass of the current measurement.
     * @param {boolean} first - write the start timestamp
     * @param {boolean} last - write the end timestamp
     */
    passWrites(first, last) {
      const { slot } = this;
      if (!slot || (!first && !last)) return undefined;
      if (first && last) return slot.writesBoth;
      return first ? slot.writesFirst : slot.writesLast;
    }

    /** Encodes the readback; call before finishing the encoder. */
    resolve(encoder) {
      if (!this.slot) return;
      encoder.resolveQuerySet(this.slot.querySet, 0, 2, this.slot.resolve, 0);
      encoder.copyBufferToBuffer(this.slot.resolve, 0, this.slot.read, 0, 16);
    }

    /** Call right after queue.submit() of the measured work. */
    submitted() {
      if (!this.usesTimestamps) {
        this.device.queue.onSubmittedWorkDone().then(this.onWallDone, this.onWallFailed);
        return;
      }
      const { slot } = this;
      this.slot = null;
      if (slot) slot.read.mapAsync(GPUMapMode.READ).then(slot.onMapped, slot.onMapFailed);
    }

    /** Drops a begun measurement whose work was never submitted. */
    abort() {
      if (this.slot) this.slot.busy = false;
      this.slot = null;
      if (!this.usesTimestamps) this.wallBusy = false;
    }

    onMapped(slot) {
      const [start, end] = new BigUint64Array(slot.read.getMappedRange());
      slot.read.unmap();
      slot.busy = false;
      // Some drivers report reset or reordered counters; skip those samples.
      if (end > start) this.time.add(Number(end - start) / 1e6);
    }

    destroy() {
      this.slots.forEach((s) => {
        s.querySet.destroy();
        s.resolve.destroy();
        s.read.destroy();
      });
      this.slots.length = 0;
    }
  }

  FSRX.gpu = { getGpu, watchGpu, createRenderPipeline, createComputePipeline, scoped, Ema, GpuTimer };
})();
