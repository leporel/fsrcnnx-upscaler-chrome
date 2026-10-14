// Shared output helpers for the parity pages. Served over http by
// run_parity.py (WebGPU needs that: headless virtual time stalls
// requestAdapter), the result is POSTed back to it; opened from file:// it
// stays in the DOM.
const harness = (() => {
  const images = {};
  const logEl = () => document.getElementById('log');

  function log(line) {
    logEl().textContent += `${line}\n`;
  }

  /** Captures the canvas; must run in the same task as the draw. */
  function shot(canvas, label) {
    const url = canvas.toDataURL('image/png');
    images[label] = url;
    const img = new Image();
    img.src = url;
    img.dataset.label = label;
    document.getElementById('imgs').appendChild(img);
  }

  async function finish() {
    if (location.protocol !== 'http:') return;
    await fetch('/result', {
      method: 'POST',
      body: JSON.stringify({ log: logEl().textContent, images }),
    });
  }

  return { log, shot, finish };
})();
