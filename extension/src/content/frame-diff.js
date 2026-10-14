// GPU frame-difference statistic between consecutive source frames, used to
// skip duplicated frames (anime drawn "on twos") and to avoid blending across
// hard scene cuts. One compute dispatch on a 1/8-resolution grid writes three
// counters; they are read back asynchronously so the frame loop never blocks.
(() => {
  const FSRX = (globalThis.FSRX ??= {});
  const { createComputePipeline } = FSRX.gpu;

  // Each grid point covers an 8x8 block, read completely with 16 bilinear
  // taps, each averaging one 2x2 texel quad (the averaging damps codec noise).
  const BLOCK = 8;
  const RESULT_BYTES = 12;
  // Fixed-point scale for summing per-point differences with u32 atomics.
  // 4K gives ~130k points: 130k * 1024 stays far below 2^32.
  const SUM_SCALE = 1024;
  // A block counts as broadly changed when its mean luma difference exceeds
  // this (8/255); used for cut detection.
  const MEAN_CHANGE = 8 / 255;
  // A block counts as touched when any single quad changed by more than this
  // (16/255). Codec noise on a re-encoded duplicate stays below it after 2x2
  // averaging, while line art moving even a few pixels (a mouth flap, a blink)
  // changes by far more. The peak, not the mean, keeps such small changes
  // from being diluted by the rest of the block.
  const PEAK_CHANGE = 16 / 255;
  // Duplicate: not a single block touched. A mouth flap at 720p spans only one
  // or two blocks, so any allowance would let it through; mistaking motion for
  // a duplicate drops a real drawing from the output, while the opposite only
  // costs a redundant in-between.
  const DUP_MEAN = 1 / 255;
  // Cut: nearly every block changed by a lot. Fast pans also change most
  // blocks, so both limits are high: a missed cut costs one ghosted mid, a
  // false cut on a pan costs one dropped mid (a visible hitch), which is worse.
  const CUT_MEAN = 0.15;
  const CUT_CHANGED = 0.75;
  // Readbacks in flight; with all of them busy a frame is left unclassified
  // and the scheduler treats it as motion.
  const STAGING_BUFFERS = 3;
  const MAX_CACHED_PAIRS = 16;
  const WORKGROUP = 8;

  const SHADER = `
@group(0) @binding(0) var prevTex: texture_2d<f32>;
@group(0) @binding(1) var curTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read_write> result: array<atomic<u32>, 3>;
var<workgroup> wgSum: atomic<u32>;
var<workgroup> wgChanged: atomic<u32>;
var<workgroup> wgTouched: atomic<u32>;
const LUMA = vec3f(0.2126, 0.7152, 0.0722);

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  let dims = textureDimensions(curTex);
  let grid = (dims + ${BLOCK - 1}u) / ${BLOCK}u;
  if (gid.x < grid.x && gid.y < grid.y) {
    let base = vec2f(gid.xy * ${BLOCK}u);
    let size = vec2f(dims);
    var sum = 0.0;
    var peak = 0.0;
    for (var ty = 0; ty < 4; ty++) {
      for (var tx = 0; tx < 4; tx++) {
        // Centre of a 2x2 quad: the bilinear tap averages its four texels.
        let uv = (base + vec2f(f32(tx) * 2.0 + 1.0, f32(ty) * 2.0 + 1.0)) / size;
        let a = textureSampleLevel(prevTex, samp, uv, 0.0).rgb;
        let b = textureSampleLevel(curTex, samp, uv, 0.0).rgb;
        let d = abs(dot(a - b, LUMA));
        sum += d;
        peak = max(peak, d);
      }
    }
    let mean = sum / 16.0;
    atomicAdd(&wgSum, u32(round(mean * ${SUM_SCALE}.0)));
    if (mean > ${MEAN_CHANGE}) { atomicAdd(&wgChanged, 1u); }
    if (peak > ${PEAK_CHANGE}) { atomicAdd(&wgTouched, 1u); }
  }
  workgroupBarrier();
  if (li == 0u) {
    atomicAdd(&result[0], atomicLoad(&wgSum));
    atomicAdd(&result[1], atomicLoad(&wgChanged));
    atomicAdd(&result[2], atomicLoad(&wgTouched));
  }
}`;

  /**
   * Classifies a frame from its difference statistic.
   * @param {number} mean - mean luma difference
   * @param {number} changed - fraction of broadly changed blocks
   * @param {number} touched - number of blocks with any visible change
   * @returns {'dup' | 'motion' | 'cut'}
   */
  function classify(mean, changed, touched) {
    if (mean < DUP_MEAN && touched === 0) return 'dup';
    if (mean > CUT_MEAN && changed > CUT_CHANGED) return 'cut';
    return 'motion';
  }

  class FrameDiff {
    /** @param {GPUDevice} device */
    constructor(device) {
      this.device = device;
      this.pipeline = null;
      this.result = device.createBuffer({
        label: 'frame-diff',
        size: RESULT_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
      this.staging = Array.from({ length: STAGING_BUFFERS }, () => ({
        busy: false,
        buffer: device.createBuffer({ size: RESULT_BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      }));
      this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      this.groups = new Map();
      this.destroyed = false;
    }

    async init() {
      this.pipeline = await createComputePipeline(this.device, { label: 'frame-diff', code: SHADER });
    }

    get ready() {
      return this.pipeline !== null;
    }

    /**
     * Compares two equally sized frames and reports the class asynchronously.
     * @param {{texture: GPUTexture, id: number}} prev
     * @param {{texture: GPUTexture, id: number}} cur
     * @param {object} target - handed back to onClass with `seq`, so callers
     *   can use one pre-bound handler instead of a closure per frame
     * @param {number} seq
     * @param {(target: object, seq: number, cls: 'dup' | 'motion' | 'cut') => void} onClass -
     *   not called when the result is unavailable (busy readbacks, device loss)
     */
    compare(prev, cur, target, seq, onClass) {
      const slot = this.staging.find((s) => !s.busy);
      if (!slot || !this.pipeline) return;
      slot.busy = true;
      const { width, height } = cur.texture;
      const gridW = Math.ceil(width / BLOCK);
      const gridH = Math.ceil(height / BLOCK);
      const encoder = this.device.createCommandEncoder();
      encoder.clearBuffer(this.result);
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup(prev, cur));
      pass.dispatchWorkgroups(Math.ceil(gridW / WORKGROUP), Math.ceil(gridH / WORKGROUP));
      pass.end();
      encoder.copyBufferToBuffer(this.result, 0, slot.buffer, 0, RESULT_BYTES);
      this.device.queue.submit([encoder.finish()]);
      const points = gridW * gridH;
      slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
        const [sum, changed, touched] = new Uint32Array(slot.buffer.getMappedRange());
        slot.buffer.unmap();
        slot.busy = false;
        if (!this.destroyed) onClass(target, seq, classify(sum / SUM_SCALE / points, changed / points, touched));
      }, () => {
        // Rejected on device loss or destroy; the session handles those itself.
        slot.busy = false;
      });
    }

    /** Bind groups per (prev, cur) texture pair; frames rotate through a small pool. */
    bindGroup(prev, cur) {
      const key = `${prev.id}|${cur.id}`;
      let group = this.groups.get(key);
      if (!group) {
        if (this.groups.size >= MAX_CACHED_PAIRS) this.groups.clear();
        group = this.device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: prev.texture.createView() },
            { binding: 1, resource: cur.texture.createView() },
            { binding: 2, resource: this.sampler },
            { binding: 3, resource: { buffer: this.result } },
          ],
        });
        this.groups.set(key, group);
      }
      return group;
    }

    /** Forgets bind groups (call when pool textures are reallocated). */
    clearCache() {
      this.groups.clear();
    }

    destroy() {
      this.destroyed = true;
      this.groups.clear();
      this.result.destroy();
      this.staging.forEach((s) => s.buffer.destroy());
    }
  }

  FSRX.FrameDiff = FrameDiff;
})();
