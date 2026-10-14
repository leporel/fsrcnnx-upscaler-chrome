// Decides when ×2 interpolation does not fit the GPU. Per source period the
// GPU must interpolate one frame and upscale two; if that does not fit the
// period, frames are shown late and playback stutters worse than without ×2.
(() => {
  const FSRX = (globalThis.FSRX ??= {});
  const { GpuTimer, Ema } = FSRX.gpu;

  // Hard limit: share of the full source period the cost may use. Throughput
  // is what matters (the scheduler drops overdue slots, so nothing queues up);
  // upstream Framegen also budgets against the whole interval.
  const HARD_SHARE = 0.9;
  // Comfortable level: the same share of half a period, i.e. every output
  // frame alone fits its own slot. Above it the HUD shows the load in orange.
  const SOFT_SHARE = 0.45;
  // Missing this share of output slots means presentation falls behind even
  // when the measured cost looks fine (CPU stalls, compositor contention).
  const MAX_LATE_SHARE = 0.25;
  const LATE_WINDOW_MS = 1000;
  // Over the limit this long before ×2 is turned off, so one-off spikes
  // (tab switch, shader warm-up) do not trip it.
  const SUSTAIN_MS = 2000;
  // Samples needed before an average is trusted.
  const MIN_SAMPLES = 10;

  class BudgetGuard {
    /** @param {{device: GPUDevice, hasTimestamps: boolean}} gpu */
    constructor(gpu) {
      this.timestamps = gpu.hasTimestamps;
      this.prep = new Ema();
      this.run = new Ema();
      // Without timestamp queries each presentation is timed from its first
      // submit to queue completion (an upper bound of its GPU time).
      this.wall = this.timestamps ? null : { mid: new GpuTimer(gpu, { wall: true }), real: new GpuTimer(gpu, { wall: true }) };
      this.overSince = 0;
      this.lastCost = 0;
      this.softLimit = 0;
      this.hardLimit = 0;
      this.lateWindowStart = 0;
      this.lateAtWindowStart = 0;
      this.lateShare = 0;
    }

    /** Runtime timestamp results ('prep' once per pair, 'run' per mid). */
    addInterp(kind, ms) {
      (kind === 'prep' ? this.prep : this.run).add(ms);
    }

    /** Call before submitting a presentation's GPU work. */
    beginPresent(kind) {
      return this.wall ? this.wall[kind].begin() : false;
    }

    /** Call after the presentation's last submit if beginPresent() returned true. */
    endPresent(kind) {
      this.wall[kind].submitted();
    }

    /**
     * Cost of one source period (interpolation + two upscaled frames), in ms;
     * 0 while there are too few samples.
     * @param {{ms: number, samples: number}} upscale - renderer's process+composite timing
     */
    cost(upscale) {
      if (this.wall) {
        const { mid, real } = this.wall;
        return mid.samples >= MIN_SAMPLES && real.samples >= MIN_SAMPLES ? mid.ms + real.ms : 0;
      }
      if (this.prep.samples < MIN_SAMPLES || this.run.samples < MIN_SAMPLES || upscale.samples < MIN_SAMPLES) return 0;
      return this.prep.value + this.run.value + 2 * upscale.ms;
    }

    /** Share of output slots missed during the last full window. */
    updateLateShare(now, periodMs, lateSlots) {
      if (this.lateWindowStart === 0 || lateSlots < this.lateAtWindowStart) {
        this.lateWindowStart = now;
        this.lateAtWindowStart = lateSlots;
        return;
      }
      const elapsed = now - this.lateWindowStart;
      if (elapsed < LATE_WINDOW_MS) return;
      const expectedSlots = (2 * elapsed) / periodMs;
      this.lateShare = (lateSlots - this.lateAtWindowStart) / expectedSlots;
      this.lateWindowStart = now;
      this.lateAtWindowStart = lateSlots;
    }

    /** Whether the cost is above the comfortable level (HUD warning only). */
    get aboveSoftLimit() {
      return this.lastCost > 0 && this.lastCost > this.softLimit;
    }

    /**
     * @param {number} now
     * @param {number} periodMs - wall-clock source period
     * @param {{ms: number, samples: number}} upscale
     * @param {number} lateSlots - scheduler's running count of missed slots
     * @returns {boolean} true once the hard limit stayed exceeded for SUSTAIN_MS
     */
    overBudget(now, periodMs, upscale, lateSlots) {
      this.lastCost = this.cost(upscale);
      this.softLimit = SOFT_SHARE * periodMs;
      this.hardLimit = HARD_SHARE * periodMs;
      this.updateLateShare(now, periodMs, lateSlots);
      const over = (this.lastCost > 0 && this.lastCost > this.hardLimit) || this.lateShare > MAX_LATE_SHARE;
      if (!over) {
        this.overSince = 0;
        return false;
      }
      if (this.overSince === 0) this.overSince = now;
      return now - this.overSince >= SUSTAIN_MS;
    }

    destroy() {
      if (!this.wall) return;
      this.wall.mid.destroy();
      this.wall.real.destroy();
    }
  }

  FSRX.BudgetGuard = BudgetGuard;
})();
