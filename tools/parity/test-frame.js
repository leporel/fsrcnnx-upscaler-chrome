// Shared synthetic input and case list for the parity pages, so the WebGL2
// baseline and the WebGPU port render exactly the same thing.
const SRC_W = 240;
const SRC_H = 135;
// Non-integer scale on purpose: at exact ratios (e.g. 3x) some output pixels
// land exactly on source texel centres, and floor() in the anti-ringing
// neighbourhood lookup may pick either side depending on float rounding.
// With 730x410, (x + 0.5) * 240 / 730 - 0.5 (and likewise for y) is never an integer.
const OUT_W = 730;
const OUT_H = 410;
// Frames rendered per case for the GPU time figure.
const TIMING_FRAMES = 30;

/**
 * Canvas posing as a <video>: the renderers only read videoWidth/videoHeight/readyState.
 * The picture is a PNG (see make_test_frame.py), so the input is bit-identical
 * across Chrome configurations; pages must be served over http.
 */
async function makeTestFrame() {
  // From file:// Chrome treats the PNG as cross-origin, taints the canvas and
  // refuses to upload it to the GPU (SecurityError).
  if (location.protocol === 'file:') {
    throw new Error('Страницу нужно открыть через http, а не как файл. В корне репозитория выполните '
      + '`python -m http.server` и откройте http://127.0.0.1:8000/tools/parity/' + location.pathname.split('/').pop()
      + ' (или запустите `python tools/parity/run_parity.py --gpu`).');
  }
  const img = new Image();
  img.src = 'test-frame.png';
  await img.decode();
  const c = document.createElement('canvas');
  c.width = SRC_W;
  c.height = SRC_H;
  c.getContext('2d').drawImage(img, 0, 0);
  c.videoWidth = SRC_W;
  c.videoHeight = SRC_H;
  c.readyState = 4;
  return c;
}

const PARITY_CASES = [
  { label: 'bypass-bilinear', model: 'none', sharpness: 0, antiring: 0, scaler: 'bilinear', split: -1 },
  { label: 'bypass-catrom', model: 'none', sharpness: 0, antiring: 0, scaler: 'catmull-rom', split: -1 },
  { label: 'fsrcnnx-8-default', model: 'fsrcnnx-8', sharpness: 0, antiring: 0.5, scaler: 'catmull-rom', split: -1 },
  { label: 'fsrcnnx-8-cas', model: 'fsrcnnx-8', sharpness: 0.5, antiring: 0, scaler: 'bilinear', split: -1 },
  { label: 'fsrcnnx-16-films', model: 'fsrcnnx-16', sharpness: 0, antiring: 0.3, scaler: 'catmull-rom', split: -1 },
  { label: 'fsrcnnx-16-anime', model: 'fsrcnnx-16-anime', sharpness: 0, antiring: 1, scaler: 'catmull-rom', split: -1 },
  { label: 'fsrcnnx-8-ab-split', model: 'fsrcnnx-8', sharpness: 0, antiring: 0.5, scaler: 'catmull-rom', split: 0.5 },
];
