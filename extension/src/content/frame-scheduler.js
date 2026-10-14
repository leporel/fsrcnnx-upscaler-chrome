// Frame pacing for ×2 interpolation. Pure timing logic: it is fed source
// frames (from requestVideoFrameCallback) and their difference class, and on
// every animation frame tells the session what to present.
//
// Output slots sit every half source period in media time. A slot at media
// position x is shown at wall time anchor + (x - anchorMedia) / rate + latency,
// where the anchor is the newest arrived frame at or before x. The latency is
// half a source period (the mid between N and N+1 can only be built once N+1
// exists) plus one display refresh, so the asynchronous difference statistic
// of the newest frame is back in time. A hard cut gets no in-between, and
// with skipDuplicates neither does a duplicated frame (anime drawn "on twos"):
// the current picture is held instead.
(() => {
  const FSRX = (globalThis.FSRX ??= {});

  const PERIOD_SAMPLES = 9;
  // Median of fewer deltas is too noisy to schedule against.
  const MIN_PERIOD_SAMPLES = 3;
  const REFRESH_SAMPLES = 15;
  const DEFAULT_REFRESH_MS = 1000 / 60;
  // A media-time gap longer than this many periods is a stall or skip, not motion.
  const MAX_GAP_PERIODS = 2;
  // Below this spacing (in display refreshes) ×2 slots would collapse onto the
  // same refresh, e.g. 60 fps video on a 60 Hz display.
  const MIN_SLOT_REFRESHES = 0.9;
  // A slot and a frame closer than this share in media time count as the same
  // position. Containers round timestamps (WebM/MSE to whole ms), so 23.976 fps
  // alternates 41/42 ms deltas: an absolute epsilon would drift off real frames.
  const MATCH_PERIODS = 0.25;
  // How long a slot may wait past its due time for a difference statistic
  // before the frame is assumed to be ordinary motion.
  const MIN_DECISION_WAIT_MS = 4;
  // Upper bound of queued frames; must stay below the interpolator's texture pool.
  const MAX_FRAMES = 5;

  const WAIT = 0;
  const SKIP = 1;
  const PRESENT = 2;

  /**
   * Running median over a fixed window. Recomputed on push (a few times per
   * second) so reads in the per-refresh path are plain field accesses.
   */
  class MedianWindow {
    constructor(size) {
      this.values = new Float64Array(size);
      this.scratch = new Float64Array(size);
      this.count = 0;
      this.next = 0;
      this.value = 0;
    }

    push(value) {
      this.values[this.next] = value;
      this.next = (this.next + 1) % this.values.length;
      this.count = Math.min(this.count + 1, this.values.length);
      // Insertion sort into the scratch buffer: no views, no garbage.
      const { scratch, values, count } = this;
      for (let i = 0; i < count; i++) {
        const v = values[i];
        let j = i - 1;
        while (j >= 0 && scratch[j] > v) {
          scratch[j + 1] = scratch[j];
          j--;
        }
        scratch[j + 1] = v;
      }
      this.value = scratch[count >> 1];
    }

    clear() {
      this.count = 0;
      this.next = 0;
      this.value = 0;
    }
  }

  /**
   * @typedef {object} SourceFrame
   * @property {number} media - mediaTime in seconds
   * @property {number} arrival - rVFC callback time (same clock as rAF)
   * @property {number} presented - metadata.presentedFrames
   * @property {'dup' | 'motion' | 'cut' | null} cls - null until classified
   * @property {boolean} first - first frame after a reset (always a keyframe)
   */

  class FrameScheduler {
    /** @param {{release: (frame: SourceFrame) => void}} hooks - frame no longer needed */
    constructor({ release }) {
      this.release = release;
      this.periods = new MedianWindow(PERIOD_SAMPLES);
      this.refreshes = new MedianWindow(REFRESH_SAMPLES);
      /** @type {SourceFrame[]} oldest first */
      this.frames = [];
      this.rate = 1;
      /** Hold the picture on duplicated frames instead of re-processing them. */
      this.skipDuplicates = false;
      this.lastTick = 0;
      this.nextX = 0;
      this.immediate = null;
      this.lastShownPresented = -1;
      this.lastShownMid = false;
      /** Reused result of tick(). */
      this.action = { kind: 'real', a: null, b: null, t: 0 };
      /** Output slots that came due while an older one was still unshown (HUD statistic). */
      this.lateSlots = 0;
      /** Slots that deliberately keep the current picture (duplicate, cut, hold). */
      this.heldSlots = 0;
    }

    /** Media-time period of the source, seconds (0 = unknown). */
    get periodS() {
      return this.periods.count >= MIN_PERIOD_SAMPLES ? this.periods.value : 0;
    }

    get refreshMs() {
      return this.refreshes.count > 0 ? this.refreshes.value : DEFAULT_REFRESH_MS;
    }

    /** Media-time tolerance for matching slots to frames. */
    get matchS() {
      return this.periodS * MATCH_PERIODS;
    }

    /** Source frame rate in frames per media second (0 = unknown). */
    get sourceFps() {
      const p = this.periodS;
      return p > 0 ? 1 / p : 0;
    }

    /** Wall-clock source period in ms, at the current playback rate. */
    get periodMs() {
      return (this.periodS * 1000) / this.rate;
    }

    /** Whether ×2 slots fit the display: false for unknown period or too-fast video. */
    get canInterpolate() {
      return this.periodS > 0 && this.periodMs / 2 >= MIN_SLOT_REFRESHES * this.refreshMs;
    }

    get latencyMs() {
      return this.periodMs * 0.5 + this.refreshMs;
    }

    /**
     * Drops all queued frames; the next source frame is shown directly.
     * @param {boolean} [forgetPeriod] - also forget the frame-rate estimate
     *   (new source, not just a seek or pause)
     */
    reset(forgetPeriod = false) {
      for (const frame of this.frames) this.release(frame);
      this.frames.length = 0;
      this.immediate = null;
      this.lastShownPresented = -1;
      if (forgetPeriod) this.periods.clear();
    }

    /** Records an animation-frame time for the refresh-rate estimate. */
    noteTick(now) {
      const delta = now - this.lastTick;
      // Gaps from throttled/background tabs are not refresh intervals.
      if (this.lastTick > 0 && delta > 0 && delta < 100) this.refreshes.push(delta);
      this.lastTick = now;
    }

    /**
     * Adds a source frame. The scheduler owns it until release() is called.
     * @param {SourceFrame} frame - media/arrival/presented filled in, cls null
     * @param {number} playbackRate
     */
    pushFrame(frame, playbackRate) {
      const last = this.frames[this.frames.length - 1] ?? null;
      let continuous = last !== null && playbackRate === this.rate;
      if (continuous) {
        const delta = frame.media - last.media;
        const period = this.periodS;
        // A rebuffering stall keeps media deltas and presentedFrames regular
        // but leaves a wall-clock gap; slots scheduled through it are stale.
        continuous = delta > 0
          && frame.presented - last.presented === 1
          && (period === 0 || (delta <= MAX_GAP_PERIODS * period
            && frame.arrival - last.arrival <= MAX_GAP_PERIODS * this.periodMs));
        if (continuous) this.periods.push(delta);
      }
      this.rate = playbackRate;
      if (!continuous || !this.canInterpolate) {
        // Shown as soon as possible, without a mid; nothing older is needed.
        this.reset();
        this.immediate = frame;
      }
      frame.first = !continuous;
      this.frames.push(frame);
      this.prune();
    }

    /**
     * Stores a frame's difference class (from the GPU statistic).
     * @param {SourceFrame} frame
     * @param {'dup' | 'motion' | 'cut'} cls
     */
    classify(frame, cls) {
      frame.cls = cls;
    }

    /**
     * Decides what to present on this animation frame.
     * @returns {{kind: 'real' | 'mid', a: SourceFrame, b: SourceFrame | null, t: number} | null}
     *   null = keep the current picture; the returned object is reused
     */
    tick(now) {
      if (this.immediate) {
        const frame = this.immediate;
        this.immediate = null;
        this.nextX = frame.media + this.periodS / 2;
        return this.present('real', frame, null, 0) === PRESENT ? this.action : null;
      }
      if (!this.canInterpolate || this.frames.length === 0) return null;
      // Pruned here rather than after a decision: the returned action's frames
      // must stay alive until the session has presented them.
      this.prune();
      const step = this.periodS / 2;
      const halfRefresh = this.refreshMs / 2;
      // Behind schedule (busy main thread, slow GPU): only the newest due slot matters.
      while (now + halfRefresh >= this.dueTime(this.nextX + step)) {
        this.nextX += step;
        this.lateSlots++;
      }
      const due = this.dueTime(this.nextX);
      if (now + halfRefresh < due) return null;
      const timedOut = now > due + Math.max(this.refreshMs, MIN_DECISION_WAIT_MS);
      const decision = this.decide(this.nextX, timedOut);
      if (decision === WAIT) return null;
      if (decision === SKIP) this.heldSlots++;
      // Re-anchoring on real frames keeps the slot phase locked to the source
      // even when the median period differs slightly from the true average.
      const shownReal = decision === PRESENT && this.action.kind === 'real';
      this.nextX = (shownReal ? this.action.a.media : this.nextX) + step;
      return decision === PRESENT ? this.action : null;
    }

    /** Wall time at which media position x is due on screen. */
    dueTime(x) {
      let anchor = this.frames[0];
      const tolerance = this.matchS;
      for (const frame of this.frames) {
        if (frame.media <= x + tolerance) anchor = frame;
        else break;
      }
      return anchor.arrival + ((x - anchor.media) * 1000) / this.rate + this.latencyMs;
    }

    /** Picks the content of the slot at media position x. */
    decide(x, timedOut) {
      const tolerance = this.matchS;
      let aIndex = -1;
      while (aIndex + 1 < this.frames.length && this.frames[aIndex + 1].media <= x + tolerance) aIndex++;
      if (aIndex < 0) return SKIP;
      const a = this.frames[aIndex];
      if (Math.abs(x - a.media) < tolerance) {
        // A duplicate of the picture already on screen needs no new upscale.
        const previousShown = !this.lastShownMid && this.lastShownPresented === a.presented - 1;
        if (this.skipDuplicates && a.cls === 'dup' && previousShown) return SKIP;
        return this.present('real', a, null, 0);
      }
      const b = this.frames[aIndex + 1];
      // The next frame is late (stall, slow decode): wait a little, then hold.
      if (!b) return timedOut ? SKIP : WAIT;
      if (b.cls === null) {
        if (!timedOut) return WAIT;
        b.cls = 'motion';
      }
      // A hard cut gets no blended in-between; a duplicate pair would blend to itself.
      if (b.cls === 'cut' || (this.skipDuplicates && b.cls === 'dup')) return SKIP;
      // Slot drifted next to the following frame: show that frame (re-anchors the phase).
      if (b.media - x < tolerance) return this.present('real', b, null, 0);
      return this.present('mid', a, b, (x - a.media) / (b.media - a.media));
    }

    present(kind, a, b, t) {
      // Frames are identified by the player's presentation counter: frame
      // objects are recycled, so object identity could match a newer frame.
      if (kind === 'real' && this.lastShownPresented === a.presented && !this.lastShownMid) return SKIP;
      const { action } = this;
      action.kind = kind;
      action.a = a;
      action.b = b;
      action.t = t;
      this.lastShownPresented = a.presented;
      this.lastShownMid = kind === 'mid';
      return PRESENT;
    }

    /** Releases frames that no future slot can use. */
    prune() {
      const newest = this.frames.length - 1;
      // The frame at or before the next slot must stay, and everything after it.
      let keep = 0;
      const tolerance = this.matchS;
      while (keep < newest && this.frames[keep + 1].media <= this.nextX + tolerance) keep++;
      if (this.frames.length - keep > MAX_FRAMES) keep = this.frames.length - MAX_FRAMES;
      if (keep > 0) {
        for (let i = 0; i < keep; i++) this.release(this.frames[i]);
        // copyWithin + length instead of splice: no garbage array per frame.
        this.frames.copyWithin(0, keep);
        this.frames.length -= keep;
      }
    }
  }

  FSRX.FrameScheduler = FrameScheduler;
})();
