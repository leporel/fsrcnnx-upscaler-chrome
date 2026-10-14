// Loads the vendored Framegen runtime (an ES module, so it needs a dynamic
// import from this classic content script) and its weights, once per
// document. Also persists the per-GPU convolution autotune result.
(() => {
  const FSRX = (globalThis.FSRX ??= {});
  const { scoped } = FSRX.gpu;

  const RUNTIME_PATH = 'vendor/framegen/rt.js';
  const WEIGHTS_PATH = 'vendor/framegen/weights/rt_v7s';
  // chrome.storage.local key; separate from the settings store keys, so
  // writing it does not trigger settings reloads.
  const TUNE_KEY = 'convTune';
  // Bump when the stored tune format or runtime version changes.
  const TUNE_VERSION = 'v1.5.3';

  /** @type {Promise<{createRT: Function, tuneConvRB: Function, weightsBin: ArrayBuffer, weightsManifest: object}> | null} */
  let pending = null;

  async function fetchResource(path, read) {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) throw new Error(`Нет файла удвоения кадров: ${path} (${response.status})`);
    return read(response);
  }

  /** Imports the runtime and fetches the weights; a failure is retried next time. */
  function loadFramegen() {
    if (!pending) {
      pending = Promise.all([
        import(chrome.runtime.getURL(RUNTIME_PATH)),
        fetchResource(`${WEIGHTS_PATH}.bin`, (r) => r.arrayBuffer()),
        fetchResource(`${WEIGHTS_PATH}.json`, (r) => r.json()),
      ]).then(([module, weightsBin, weightsManifest]) => ({
        createRT: module.createRT,
        tuneConvRB: module.tuneConvRB,
        weightsBin,
        weightsManifest,
      }));
      pending.catch(() => { pending = null; });
    }
    return pending;
  }

  function tuneKey(gpuName, w, h) {
    return `${TUNE_VERSION}|${gpuName}|${w}x${h}`;
  }

  /** @returns {Promise<object | null>} stored tune for this GPU and model size */
  async function loadConvTune(gpuName, w, h) {
    const { [TUNE_KEY]: all } = await chrome.storage.local.get(TUNE_KEY);
    const tune = all?.[tuneKey(gpuName, w, h)];
    return tune && typeof tune === 'object' ? tune : null;
  }

  /**
   * Benchmarks kernel variants on this GPU (a few hundred ms of GPU work) and
   * stores the winner for the next runtime build.
   * @param {GPUDevice} device
   */
  async function runConvTune(device, gpuName, w, h) {
    const { tuneConvRB, weightsManifest } = await loadFramegen();
    const c1 = weightsManifest['block0.conv0.0.0.weight'].shape[0];
    const c2 = weightsManifest['block0.conv0.1.0.weight'].shape[0];
    const best = await scoped(device, () => tuneConvRB(device, { ci: c2, co: c2, w16: w / 16, h16: h / 16, s2ci: c1 }));
    // Every flag the runtime reads must survive the round trip through storage.
    const tune = {
      coc: best.coc, slab: best.slab, sg: Boolean(best.sg), wgx: best.wgx || 8, wgy: best.wgy || 8,
      w4: Boolean(best.w4), v2: Boolean(best.v2),
    };
    if (best.s2) tune.s2 = { coc: best.s2.coc, w4: Boolean(best.s2.w4) };
    const { [TUNE_KEY]: all = {} } = await chrome.storage.local.get(TUNE_KEY);
    await chrome.storage.local.set({ [TUNE_KEY]: { ...all, [tuneKey(gpuName, w, h)]: tune } });
  }

  FSRX.framegen = { loadFramegen, loadConvTune, runConvTune };
})();
