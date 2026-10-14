// Frame generation for one session: feeds video frames to the interpolator
// and the scheduler, and keeps the ×2 state shown in the HUD and popup.
(() => {
  const FSRX = (globalThis.FSRX ??= {});
  const { Interpolator, FrameScheduler, BudgetGuard, errorMessage } = FSRX;

  // How long the HUD keeps the "repeats skipped" note after the last duplicate.
  const DEDUP_BADGE_MS = 2000;

  /** @typedef {'loading' | 'active' | 'blocked' | 'error'} InterpState */

  class InterpolationController {
    /**
     * @param {{device: GPUDevice, name: string, hasTimestamps: boolean}} gpu
     * @param {HTMLVideoElement} video
     * @param {{skipDuplicates: boolean, onStateChange: () => void}} options
     */
    constructor(gpu, video, { skipDuplicates, onStateChange }) {
      this.video = video;
      this.onStateChange = onStateChange;
      /** @type {InterpState} */
      this.state = 'loading';
      this.note = '';
      this.seq = 0;
      this.lastDupAt = -Infinity;
      // Announced once the frame rate is known and ×2 output actually starts.
      this.announcedInterp = false;
      this.guard = new BudgetGuard(gpu);
      this.interpolator = new Interpolator(gpu, {
        isIdle: () => video.paused,
        onMeasure: (kind, ms) => this.guard.addInterp(kind, ms),
      });
      /** Frame objects are recycled: one per queued source frame, not per arrival. */
      this.spareFrames = [];
      this.scheduler = new FrameScheduler({ release: (frame) => this.releaseFrame(frame) });
      this.scheduler.skipDuplicates = skipDuplicates;
      this.onClass = this.onClass.bind(this);
      this.onMidError = (error) => { if (error) this.failRuntime(new Error(`ошибка видеокарты: ${error.message}`)); };
    }

    /** Whether frames currently go through the interpolation path. */
    get active() {
      return this.state === 'active';
    }

    /** Live switch; takes effect from the next output slot. */
    setSkipDuplicates(enabled) {
      this.scheduler.skipDuplicates = enabled;
    }

    /** Drops queued frames, e.g. after seek, pause, rate change or a hidden overlay. */
    reset() {
      this.scheduler.reset();
      this.interpolator.dropPrev();
    }

    /**
     * Takes a new video frame (rVFC). Returns false when the session should
     * render it the plain way (paused, runtime not ready, ×2 disabled).
     * @param {number} now
     * @param {VideoFrameCallbackMetadata} meta
     */
    onVideoFrame(now, meta) {
      if (this.state === 'blocked' || this.state === 'error') return false;
      const { video, interpolator } = this;
      if (video.paused) {
        this.reset();
        return false;
      }
      const { videoWidth: w, videoHeight: h } = video;
      if (w !== interpolator.srcW || h !== interpolator.srcH) this.scheduler.reset(true);
      interpolator.setSourceSize(w, h);
      if (interpolator.error) {
        this.failRuntime(interpolator.error);
        return false;
      }
      if (!interpolator.ready) return false;
      this.setState('active', '');

      const frame = this.spareFrames.pop() ?? { slot: null, media: 0, arrival: 0, presented: 0, cls: null, first: false, seq: 0 };
      frame.seq = ++this.seq;
      frame.cls = null;
      frame.slot = interpolator.pushFrame(video, frame, frame.seq, this.onClass);
      if (!frame.slot) {
        // Pool exhausted (should not happen with the scheduler's limits): start over.
        this.reset();
        frame.slot = interpolator.pushFrame(video, frame, frame.seq, this.onClass);
        if (!frame.slot) {
          this.spareFrames.push(frame);
          return false;
        }
      }
      frame.media = meta.mediaTime;
      frame.arrival = now;
      frame.presented = meta.presentedFrames;
      this.scheduler.pushFrame(frame, video.playbackRate);
      // Announce the first start only; adaptive-quality switches restart the
      // frame-rate estimate and would otherwise pop the HUD on every change.
      if (this.scheduler.canInterpolate && !this.announcedInterp) {
        this.announcedInterp = true;
        this.onStateChange();
      }
      return true;
    }

    onClass(frame, seq, cls) {
      // The frame object may already be recycled for a newer frame.
      if (frame.seq !== seq || frame.slot === null) return;
      this.scheduler.classify(frame, cls);
      if (cls === 'dup' && this.scheduler.skipDuplicates) this.lastDupAt = performance.now();
    }

    releaseFrame(frame) {
      this.interpolator.release(frame.slot);
      frame.slot = null;
      frame.seq = 0;
      this.spareFrames.push(frame);
    }

    /**
     * @returns {{kind: 'real' | 'mid', a: object, b: object | null, t: number} | null}
     */
    tick(now) {
      this.scheduler.noteTick(now);
      return this.active ? this.scheduler.tick(now) : null;
    }

    /** Running count of slots that intentionally repeat the current picture. */
    get heldSlots() {
      return this.scheduler.heldSlots;
    }

    /**
     * Texture to upscale for a scheduler action (renders the mid if needed).
     * @returns {GPUTexture | null} null when the runtime failed; ×2 is then
     *   off and the caller should render the video directly
     */
    sourceFor(action) {
      if (action.kind === 'real') return action.a.slot.texture;
      const { device } = this.interpolator;
      // Runtime errors must disable ×2, not reach the device-wide handler.
      device.pushErrorScope('validation');
      try {
        return this.interpolator.mid(action.a.slot, action.b.slot, action.t);
      } catch (err) {
        this.failRuntime(err);
        return null;
      } finally {
        device.popErrorScope().then(this.onMidError, this.onMidError);
      }
    }

    /** The interpolation runtime failed: keep upscaling, report and stop ×2. */
    failRuntime(err) {
      if (this.state === 'error') return;
      console.error('[FSRCNNX]', err);
      this.setState('error', `удвоение кадров не работает: ${errorMessage(err)}`);
      this.release();
    }

    beginPresent(kind) {
      return this.guard.beginPresent(kind);
    }

    endPresent(kind) {
      this.guard.endPresent(kind);
    }

    /**
     * Checks the GPU budget after a presentation; turns ×2 off for the session
     * when it stays exceeded.
     * @param {{ms: number, samples: number}} upscale - renderer timing
     * @returns {boolean} true if ×2 was just disabled
     */
    checkBudget(now, upscale) {
      if (!this.active || !this.scheduler.canInterpolate) return false;
      if (!this.guard.overBudget(now, this.scheduler.periodMs, upscale, this.scheduler.lateSlots)) return false;
      this.setState('blocked', 'видеокарта не успевает удваивать кадры при таком разрешении, ×2 выключено');
      this.release();
      return true;
    }

    setState(state, note) {
      if (this.state === state && this.note === note) return;
      this.state = state;
      this.note = note;
      this.onStateChange();
    }

    /** Frees GPU memory but keeps the state for the HUD/popup. */
    release() {
      this.scheduler.reset(true);
      this.interpolator.destroy();
    }

    /** Summary for the HUD and popup. */
    status(now) {
      const { scheduler } = this;
      const sourceFps = scheduler.sourceFps;
      let note = this.note;
      if (this.state === 'loading') note = '×2 запускается…';
      else if (this.active && sourceFps > 0 && !scheduler.canInterpolate) note = '×2 не нужно: частота кадров видео уже высокая для этого монитора';
      return {
        state: this.state,
        note,
        interpolating: this.active && scheduler.canInterpolate,
        sourceFps: Math.round(sourceFps * 100) / 100,
        dedup: now - this.lastDupAt < DEDUP_BADGE_MS,
        latencyMs: this.active ? Math.round(scheduler.latencyMs) : 0,
        textureMB: Math.round(this.interpolator.textureBytes / (1024 * 1024)),
        lateSlots: scheduler.lateSlots,
        // GPU cost of one source period (0 = no data yet) against the
        // comfortable level and the hard limit that turns ×2 off.
        costMs: this.guard.lastCost,
        softLimitMs: this.guard.softLimit,
        hardLimitMs: this.guard.hardLimit,
        overSoftLimit: this.guard.aboveSoftLimit,
      };
    }

    destroy() {
      this.release();
      this.guard.destroy();
    }
  }

  FSRX.InterpolationController = InterpolationController;
})();
