// One upscaling session bound to one <video>: owns the overlay, the renderer,
// the optional ×2 frame generation and the frame loop.
(() => {
  const FSRX = (globalThis.FSRX ??= {});
  const {
    Overlay, Renderer, InterpolationController, MODELS, PRESETS, CUSTOM_PRESET, MESSAGES,
    sendToWorker, randomToken, errorMessage, formatSize, formatFrameGen,
  } = FSRX;
  const { parseHookShader } = FSRX.mpvHook;
  const { visibleArea } = FSRX.videoFinder;

  // Automatic HUD pop-ups (start, preset or state changes) stay short.
  const HUD_DURATION_MS = 2000;
  // Sources whose shorter side reaches this (1440p, 4K, 1440x2560 vertical)
  // are detailed enough already: upscaling is skipped even when enabled.
  const NATIVE_DETAIL_SIDE = 1440;
  // Errors stay longer: the overlay is torn down right after a fatal one.
  const ERROR_HUD_MS = 4000;
  // Fallback check for players that swap the video or drop our overlay node.
  const WATCHDOG_MS = 1000;
  // Window over which the HUD/popup frame-rate figure is averaged.
  const FPS_WINDOW_MS = 1000;
  // Video events after which a paused video shows a different frame.
  const NEW_FRAME_EVENTS = ['seeked', 'loadeddata', 'resize', 'play', 'emptied'];
  // Video events after which queued frames for interpolation are stale.
  const RESET_EVENTS = ['seeking', 'pause', 'play', 'ratechange', 'emptied'];

  /** Parsed shaders are shared by all sessions in the frame. */
  const parsedModels = new Map();

  async function fetchModelPasses(modelId) {
    if (!parsedModels.has(modelId)) {
      const { source } = await sendToWorker({ type: MESSAGES.SHADER_GET, modelId });
      parsedModels.set(modelId, parseHookShader(source));
    }
    return parsedModels.get(modelId);
  }

  function describeError(err) {
    if (err?.name === 'SecurityError') {
      return 'Видео загружено с другого сайта без разрешения (CORS), браузер не даёт обрабатывать его кадры';
    }
    return errorMessage(err);
  }

  /** Native controls and WebVTT captions are drawn inside <video>, under our canvas. */
  function coversNativeUi(video) {
    return video.controls || Array.from(video.textTracks).some((track) => track.mode === 'showing');
  }

  class Session {
    /**
     * @param {HTMLVideoElement} video
     * @param {{enabled: boolean, settings: object}} config
     * @param {{onEnd: (session: Session) => void}} callbacks
     */
    constructor(video, config, { onEnd }) {
      this.token = randomToken();
      this.video = video;
      this.settings = config.settings;
      this.enabled = config.enabled;
      this.onEnd = onEnd;
      this.model = null;
      this.activeModel = null;
      this.loadingModel = null;
      this.loadGeneration = 0;
      this.error = null;
      this.failed = false;
      // Set when the player dropped or hid the video (next episode, player rebuild).
      this.videoLost = false;
      this.destroyed = false;
      this.hasPicture = true;
      this.lastResult = null;
      this.lastLayout = null;
      this.processKey = '';
      this.frameCallbackId = 0;
      this.rafId = 0;
      this.pendingNewFrame = false;
      this.pendingComposite = false;
      this.fps = { frames: 0, since: performance.now(), value: 0 };
      // Player-side dropped frames are reported relative to the session start.
      this.droppedBase = video.getVideoPlaybackQuality().droppedVideoFrames;

      this.renderer = null;
      /** @type {InterpolationController | null} */
      this.interp = null;
      this.onFrame = this.onFrame.bind(this);
      this.onAnimationFrame = this.onAnimationFrame.bind(this);
      this.requestFrame = () => this.schedule(true);
      this.requestComposite = () => this.schedule(false);
      this.resetInterp = () => this.interp?.reset();
      this.onVisibility = () => { if (document.hidden) this.resetInterp(); };
      this.overlay = new Overlay(video, { onSplitChange: this.requestComposite });
    }

    async start() {
      try {
        this.renderer = new Renderer(this.overlay.canvas, { onFatal: (err) => this.fail(err) });
        await this.renderer.init();
      } catch (err) {
        this.fail(err);
        return;
      }
      if (this.destroyed) return;
      this.listen();
      this.overlay.setCompare(this.settings.compare);
      this.syncInterp();
      this.applyEnabled();
      const loading = this.settings.upscale ? this.loadModel(this.settings.model) : null;
      // Show "Compiling shaders…" right away; compiling the 16-channel models takes a while.
      this.announce();
      await loading;
      this.announce();
    }

    listen() {
      this.resizeObserver = new ResizeObserver(this.requestComposite);
      this.resizeObserver.observe(this.video);
      NEW_FRAME_EVENTS.forEach((type) => this.video.addEventListener(type, this.requestFrame));
      RESET_EVENTS.forEach((type) => this.video.addEventListener(type, this.resetInterp));
      // Hidden tabs stop rAF and rVFC; resuming must not show a stale pair.
      document.addEventListener('visibilitychange', this.onVisibility);
      window.addEventListener('resize', this.requestComposite);
      document.addEventListener('fullscreenchange', this.requestComposite);
      // Scrolling an inner container moves the video without resizing it.
      document.addEventListener('scroll', this.requestComposite, { capture: true, passive: true });
      this.watchdog = setInterval(() => this.checkHealth(), WATCHDOG_MS);
    }

    unlisten() {
      this.resizeObserver?.disconnect();
      NEW_FRAME_EVENTS.forEach((type) => this.video.removeEventListener(type, this.requestFrame));
      RESET_EVENTS.forEach((type) => this.video.removeEventListener(type, this.resetInterp));
      document.removeEventListener('visibilitychange', this.onVisibility);
      window.removeEventListener('resize', this.requestComposite);
      document.removeEventListener('fullscreenchange', this.requestComposite);
      document.removeEventListener('scroll', this.requestComposite, { capture: true });
      clearInterval(this.watchdog);
    }

    /**
     * Players switching episodes either remove the old <video> or keep it
     * hidden and paused while a new one plays.
     */
    get videoGone() {
      const { video } = this;
      return !video.isConnected || (video.paused && visibleArea(video) === 0);
    }

    checkHealth() {
      // Extension reloaded or updated: this copy is orphaned and a fresh one
      // may attach its own overlay, so step aside.
      if (!chrome.runtime?.id) {
        this.destroy();
        return;
      }
      if (this.videoGone) {
        // A failed session is not followed: the next video would fail the same way.
        this.videoLost = !this.failed;
        this.destroy();
        return;
      }
      this.overlay.attachHost();
      // The pinned A/B HUD has no timer, so keep its numbers current.
      if (this.hudPinned && this.overlay.hudVisible) this.overlay.showHud(this.hudContent(), 0);
    }

    isCurrentLoad(generation) {
      return generation === this.loadGeneration && !this.destroyed && this.renderer !== null;
    }

    /** Never rejects: failures are reported through the HUD and popup status. */
    async loadModel(modelId) {
      const generation = ++this.loadGeneration;
      this.loadingModel = modelId;
      try {
        const passes = await fetchModelPasses(modelId);
        if (!this.isCurrentLoad(generation)) return;
        const model = await this.renderer.loadModel(modelId, passes);
        // A newer request (or teardown) superseded this one while compiling.
        if (!this.isCurrentLoad(generation)) return;
        this.model = model;
        this.activeModel = modelId;
        this.error = null;
      } catch (err) {
        if (this.isCurrentLoad(generation)) this.reportError(err);
      } finally {
        if (generation === this.loadGeneration) this.loadingModel = null;
      }
      this.requestFrame();
    }

    /** @param {{enabled: boolean, settings: object}} config */
    applyConfig(config) {
      const prev = this.settings;
      this.settings = config.settings;
      if (this.enabled !== config.enabled) {
        this.enabled = config.enabled;
        this.applyEnabled();
        if (this.enabled) this.announce();
      }
      if (prev.compare !== this.settings.compare) this.overlay.setCompare(this.settings.compare);
      const wasPinned = prev.compare || prev.showHud;
      if (wasPinned !== this.hudPinned) {
        if (this.hudPinned) this.announce();
        else this.overlay.hideHud();
      }
      // Before init() finishes there is no device yet; start() loads the current model then.
      // With upscaling off no model is compiled until it is turned back on.
      const needsModel = this.settings.upscale && this.renderer?.builtins
        && (prev.model !== this.settings.model || this.activeModel !== this.settings.model);
      if (needsModel) {
        this.loadModel(this.settings.model).then(() => this.announce());
      } else if (prev.preset !== this.settings.preset || prev.frameGen !== this.settings.frameGen
        || prev.upscale !== this.settings.upscale) {
        this.announce();
      }
      this.syncInterp(prev);
      // Sharpness changes are caught by the process key in render().
      this.requestComposite();
    }

    /**
     * Creates, updates or drops frame generation to match the settings. A
     * controller that gave up (GPU too slow, runtime failure) is retried only
     * after some setting changed.
     * @param {object} [prev] - settings before the change
     */
    syncInterp(prev) {
      const gpu = this.renderer?.gpu;
      if (!this.settings.frameGen || !gpu) {
        this.interp?.destroy();
        this.interp = null;
        return;
      }
      const gaveUp = this.interp && (this.interp.state === 'blocked' || this.interp.state === 'error');
      if (gaveUp && prev && Object.keys(this.settings).some((key) => prev[key] !== this.settings[key])) {
        this.interp.destroy();
        this.interp = null;
      }
      if (this.interp) {
        this.interp.setSkipDuplicates(this.settings.skipDuplicates);
        return;
      }
      this.interp = new InterpolationController(gpu, this.video, {
        skipDuplicates: this.settings.skipDuplicates,
        onStateChange: () => this.announce(),
      });
    }

    applyEnabled() {
      this.overlay.setVisible(this.enabled && this.hasPicture);
      if (this.enabled) {
        this.scheduleFrameCallback();
        this.requestFrame();
      } else {
        this.cancelFrameCallback();
      }
    }

    setHasPicture(hasPicture) {
      if (this.hasPicture === hasPicture) return;
      this.hasPicture = hasPicture;
      this.overlay.setVisible(this.enabled && hasPicture);
    }

    scheduleFrameCallback() {
      if (!this.frameCallbackId) this.frameCallbackId = this.video.requestVideoFrameCallback(this.onFrame);
    }

    cancelFrameCallback() {
      if (this.frameCallbackId) this.video.cancelVideoFrameCallback(this.frameCallbackId);
      this.frameCallbackId = 0;
    }

    /**
     * @param {number} now
     * @param {VideoFrameCallbackMetadata} meta
     */
    onFrame(now, meta) {
      this.frameCallbackId = 0;
      if (this.destroyed || !this.enabled) return;
      this.scheduleFrameCallback();
      if (this.interp && this.renderer?.builtins) {
        let queued;
        try {
          queued = this.interp.onVideoFrame(now, meta);
        } catch (err) {
          this.fail(err);
          return;
        }
        if (queued) {
          // Presented by the animation-frame loop at the paced time.
          this.requestTick();
          return;
        }
      }
      this.render(true);
    }

    /**
     * Coalesces redraw requests into one per animation frame.
     * @param {boolean} newFrame - the video frame changed, so the network must rerun
     */
    schedule(newFrame) {
      if (this.destroyed || !this.enabled) return;
      this.pendingNewFrame ||= newFrame;
      this.pendingComposite = true;
      this.requestTick();
    }

    requestTick() {
      if (!this.rafId) this.rafId = requestAnimationFrame(this.onAnimationFrame);
    }

    onAnimationFrame(now) {
      this.rafId = 0;
      if (this.destroyed || !this.enabled) return;
      const rerun = this.pendingNewFrame;
      const redraw = this.pendingComposite;
      this.pendingNewFrame = false;
      this.pendingComposite = false;
      // A new picture outside the paced stream (seek, play, model loaded) replaces the queue.
      if (rerun) this.resetInterp();
      const heldBefore = this.interp?.heldSlots ?? 0;
      const action = this.interp && !rerun ? this.interp.tick(now) : null;
      if (action) this.present(action, now);
      else if (rerun || redraw) this.render(rerun);
      // A deliberately repeated picture (duplicate drawing, cut) is still an
      // output frame; without this the HUD rate dips on held anime frames.
      if (!action && this.interp && this.interp.heldSlots > heldBefore) this.countFrame();
      // Pacing needs every display refresh while interpolated frames are queued.
      if (this.interp?.active && !this.video.paused) this.requestTick();
    }

    /** Upscales and shows a scheduled real or interpolated frame. */
    present(action, now) {
      if (!this.renderer?.builtins) return;
      const layout = this.isRenderable() ? this.overlay.updateLayout() : null;
      this.setHasPicture(Boolean(layout));
      if (!layout) {
        this.resetInterp();
        return;
      }
      const { kind } = action;
      try {
        const measuring = this.interp.beginPresent(kind);
        const source = this.interp.sourceFor(action);
        if (!source) {
          // ×2 just failed and turned itself off; show the video directly.
          this.render(true);
          return;
        }
        const { width: srcW, height: srcH } = action.a.slot.texture;
        this.lastResult = this.renderer.process(
          source,
          { w: layout.frameW, h: layout.frameH },
          this.upscaleModel,
          this.upscaleSharpness,
          { srcW, srcH, real: kind === 'real' },
        );
        this.processKey = this.makeProcessKey(layout);
        this.composite(layout);
        if (measuring) this.interp.endPresent(kind);
        this.countFrame();
        this.interp.checkBudget(now, this.renderer.timer);
      } catch (err) {
        this.fail(err);
      }
    }

    /** False when there is nothing to show: no frame yet, or the <video> itself is fullscreen (top layer hides us). */
    isRenderable() {
      return this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        && document.fullscreenElement !== this.video;
    }

    /** Compiled model to run, or null when upscaling is off (plain scaling). */
    /** The current source is 1440p or larger, so upscaling is skipped. */
    get sourceTooLarge() {
      return Math.min(this.video.videoWidth, this.video.videoHeight) >= NATIVE_DETAIL_SIDE;
    }

    /** Upscaling is enabled and worth running on the current source. */
    get upscaleActive() {
      return this.settings.upscale && !this.sourceTooLarge;
    }

    get upscaleModel() {
      return this.upscaleActive ? this.model : null;
    }

    /** CAS belongs to the upscaling stage and is off with it. */
    get upscaleSharpness() {
      return this.upscaleActive ? this.settings.sharpness : 0;
    }

    makeProcessKey(layout) {
      const model = this.upscaleActive ? this.activeModel : 'off';
      return `${model}|${this.upscaleSharpness}|${layout.frameW}x${layout.frameH}`;
    }

    composite(layout) {
      this.renderer.composite(layout, {
        antiring: this.settings.antiring,
        scaler: this.settings.scaler,
        split: this.overlay.shaderSplit,
      });
      this.lastLayout = layout;
    }

    render(newFrame) {
      if (!this.renderer?.builtins) return;
      const layout = this.isRenderable() ? this.overlay.updateLayout() : null;
      this.setHasPicture(Boolean(layout));
      if (!layout) {
        this.resetInterp();
        return;
      }
      try {
        const key = this.makeProcessKey(layout);
        // While interpolating, the next paced frame (at most half a period
        // away) picks up a new size or sharpness; re-uploading the video here
        // would jump ahead of the queued frames.
        const paced = this.interp?.active && !this.video.paused;
        if (newFrame || !this.lastResult || (key !== this.processKey && !paced)) {
          const { videoWidth: srcW, videoHeight: srcH } = this.video;
          this.lastResult = this.renderer.process(
            this.renderer.uploadVideo(this.video),
            { w: layout.frameW, h: layout.frameH },
            this.upscaleModel,
            this.upscaleSharpness,
            { srcW, srcH },
          );
          this.processKey = key;
          this.countFrame();
        }
        this.composite(layout);
      } catch (err) {
        this.fail(err);
      }
    }

    countFrame() {
      const now = performance.now();
      this.fps.frames++;
      if (now - this.fps.since >= FPS_WINDOW_MS) {
        this.fps.value = Math.round((this.fps.frames * 1000) / (now - this.fps.since));
        this.fps.frames = 0;
        this.fps.since = now;
      }
    }

    /** The HUD stays on screen while "Show HUD" or A/B comparison is on. */
    get hudPinned() {
      return this.settings.showHud || this.settings.compare;
    }

    /** Shows the HUD; pinned or for a short pop-up (see hudPinned). */
    announce() {
      if (this.destroyed || !this.enabled) return;
      const duration = this.hudPinned ? 0 : HUD_DURATION_MS;
      // The first frame may not be rendered yet; wait one frame for real sizes.
      requestAnimationFrame(() => {
        if (!this.destroyed) this.overlay.showHud(this.hudContent(), duration);
      });
    }

    hudContent() {
      if (this.error) return { title: 'Ошибка FSRCNNX', lines: [{ text: this.error }], level: 'error' };
      const presetLabel = PRESETS[this.settings.preset]?.label
        ?? (this.settings.preset === CUSTOM_PRESET ? 'Свой' : '');
      const title = this.upscaleActive
        ? `${MODELS[this.settings.model].label} · ${presetLabel}`
        : 'Без увеличения';
      if (this.upscaleActive && this.loadingModel) {
        return { title, lines: [{ text: 'Подготовка шейдеров…' }], level: 'warn' };
      }
      const { videoWidth: vw, videoHeight: vh } = this.video;
      const layout = this.lastLayout;
      if (!this.lastResult || !layout) return { title, lines: [{ text: `Исходник ${formatSize(vw, vh)}` }], level: 'ok' };

      const { modelApplied, lumaW, lumaH } = this.lastResult;
      const out = formatSize(layout.outW, layout.outH);
      const lines = [];
      let warn = false;
      if (!this.upscaleActive) {
        lines.push({ text: `${formatSize(vw, vh)} → ${out}` });
        if (this.settings.upscale) lines.push({ text: 'увеличение не нужно: видео 1440p или больше' });
      } else if (modelApplied) {
        lines.push({ text: `${formatSize(vw, vh)} → ${formatSize(lumaW, lumaH)} → ${out}` });
      } else {
        lines.push({ text: `${formatSize(vw, vh)} → ${out}` });
        lines.push({ text: 'без нейросети: плеер слишком мал для увеличения в 2 раза', warn: true });
        warn = true;
      }
      const interpStatus = this.interp?.status(performance.now()) ?? null;
      const interpText = formatFrameGen(interpStatus);
      if (interpText) {
        const interpWarn = interpStatus.state === 'blocked' || interpStatus.state === 'error';
        lines.push({ text: interpText, warn: interpWarn });
        warn ||= interpWarn;
      }
      if (coversNativeUi(this.video)) {
        lines.push({ text: 'встроенные кнопки и субтитры плеера скрыты под картинкой', warn: true });
        warn = true;
      }
      if (this.hudPinned) lines.push(...this.statsLines(interpStatus));
      return { title, lines, level: warn ? 'warn' : 'ok' };
    }

    /**
     * Live numbers for the pinned HUD (refreshed every second by checkHealth),
     * one per line.
     * @param {object | null} interpStatus - InterpolationController.status()
     */
    statsLines(interpStatus) {
      // The rate is only recomputed when frames are drawn; a paused video draws none.
      const stale = performance.now() - this.fps.since > 2 * FPS_WINDOW_MS;
      const lines = [{ text: `вывод: ${stale ? 0 : this.fps.value} кадр/с` }];
      const timer = this.renderer?.timer;
      if (timer?.samples > 0) {
        // Without timestamp queries the figure is queue wall time (an upper bound).
        const approx = timer.usesTimestamps ? '' : '≤';
        lines.push({ text: `видеокарта: ${approx}${timer.ms.toFixed(1)} мс/кадр` });
      }
      if (interpStatus?.state === 'active') {
        if (interpStatus.costMs > 0) {
          lines.push({
            text: `×2 нагрузка: ${interpStatus.costMs.toFixed(1)} мс `
              + `(комфортно до ${interpStatus.softLimitMs.toFixed(1)}, предел ${interpStatus.hardLimitMs.toFixed(1)})`,
            warn: interpStatus.overSoftLimit,
          });
        }
        lines.push({ text: `задержка картинки: ${interpStatus.latencyMs} мс` });
        lines.push({ text: `пропуски ×2: ${interpStatus.lateSlots}` });
        lines.push({ text: `память ×2: ${interpStatus.textureMB} МБ` });
      }
      const dropped = this.video.getVideoPlaybackQuality().droppedVideoFrames - this.droppedBase;
      lines.push({ text: `пропуски плеера: ${dropped}` });
      for (const line of lines) line.dim = true;
      return lines;
    }

    getStatus() {
      const result = this.lastResult;
      return {
        token: this.token,
        enabled: this.enabled,
        error: this.error,
        loadingModel: this.loadingModel,
        activeModel: this.activeModel,
        source: { w: this.video.videoWidth, h: this.video.videoHeight },
        output: this.lastLayout ? { w: this.lastLayout.outW, h: this.lastLayout.outH } : null,
        modelApplied: Boolean(result?.modelApplied),
        upscale: this.upscaleActive,
        upscaleSkippedLarge: this.settings.upscale && this.sourceTooLarge,
        fps: this.fps.value,
        gpu: this.renderer?.gpuName ?? null,
        frameGen: this.interp?.status(performance.now()) ?? null,
      };
    }

    reportError(err) {
      this.error = describeError(err);
      console.error('[FSRCNNX]', err);
      this.overlay.showHud(this.hudContent(), ERROR_HUD_MS);
    }

    /** Unrecoverable failure: keep the message visible briefly, then tear down. */
    fail(err) {
      if (this.destroyed || this.failed) return;
      this.failed = true;
      this.reportError(err);
      this.cancelFrameCallback();
      this.disposeRenderer();
      this.overlay.canvas.style.display = 'none';
      setTimeout(() => this.destroy(), ERROR_HUD_MS);
    }

    disposeRenderer() {
      // The interpolator shares the renderer's device; drop it first.
      this.interp?.destroy();
      this.interp = null;
      this.renderer?.destroy();
      this.renderer = null;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.cancelFrameCallback();
      cancelAnimationFrame(this.rafId);
      this.unlisten();
      this.disposeRenderer();
      this.overlay.destroy();
      this.onEnd(this);
    }
  }

  FSRX.Session = Session;
})();
