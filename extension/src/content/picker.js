// Interactive player picker. Runs independently in every frame: listeners are
// non-blocking (no full-page shield), so hovering an iframe hands control to
// the picker instance living inside that iframe.
(() => {
  const FSRX = (globalThis.FSRX ??= {});
  const { findVideoAt } = FSRX.videoFinder;

  const SWALLOWED_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'auxclick'];
  const MAX_Z = '2147483647';

  const STYLE = `
:host { all: initial; }
.box { position: fixed; pointer-events: none; display: none; box-sizing: border-box;
  border: 2px solid #5eead4; border-radius: 6px; background: rgba(94, 234, 212, .12);
  box-shadow: 0 0 0 9999px rgba(8, 10, 14, .35), 0 0 24px rgba(94, 234, 212, .45);
  transition: left .08s ease, top .08s ease, width .08s ease, height .08s ease; }
.box.miss { border-color: #f87171; background: rgba(248, 113, 113, .1); box-shadow: none; }
.chip { position: absolute; left: 8px; top: 8px; padding: 6px 10px; border-radius: 8px; white-space: nowrap;
  font: 600 12px/1.2 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; color: #0b1013; background: #5eead4; }
.box.miss .chip { color: #fff; background: #ef4444; }
.banner { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); pointer-events: none;
  padding: 10px 16px; border-radius: 12px; color: #eef1f6; background: rgba(14,16,21,.88);
  border: 1px solid rgba(255,255,255,.1); box-shadow: 0 10px 30px rgba(0,0,0,.4);
  font: 500 13px/1.2 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
.banner kbd { font: inherit; padding: 1px 6px; border-radius: 5px; background: rgba(255,255,255,.12); }
`;

  class Picker {
    constructor() {
      this.active = false;
      this.onPick = null;
      this.onCancel = null;
      this.candidate = null;
      this.cache = new WeakMap();
      this.rafId = 0;
      this.lastPoint = null;
      this.host = null;
      this.cursorStyle = null;
      this.handleMove = this.handleMove.bind(this);
      this.handleClick = this.handleClick.bind(this);
      this.handleKey = this.handleKey.bind(this);
      this.swallow = this.swallow.bind(this);
      this.handleLeave = () => this.highlight(null, false);
    }

    /**
     * @param {{onPick: (video: HTMLVideoElement) => void, onCancel: () => void}} handlers
     */
    start({ onPick, onCancel }) {
      if (this.active) this.stop();
      this.active = true;
      this.onPick = onPick;
      this.onCancel = onCancel;
      this.cache = new WeakMap();
      this.mountUi();
      window.addEventListener('mousemove', this.handleMove, true);
      window.addEventListener('click', this.handleClick, true);
      window.addEventListener('keydown', this.handleKey, true);
      document.documentElement.addEventListener('mouseleave', this.handleLeave);
      SWALLOWED_EVENTS.forEach((type) => window.addEventListener(type, this.swallow, true));
    }

    stop() {
      if (!this.active) return;
      this.active = false;
      cancelAnimationFrame(this.rafId);
      window.removeEventListener('mousemove', this.handleMove, true);
      window.removeEventListener('click', this.handleClick, true);
      window.removeEventListener('keydown', this.handleKey, true);
      document.documentElement.removeEventListener('mouseleave', this.handleLeave);
      SWALLOWED_EVENTS.forEach((type) => window.removeEventListener(type, this.swallow, true));
      this.host?.remove();
      this.cursorStyle?.remove();
      this.host = null;
      this.cursorStyle = null;
      this.candidate = null;
    }

    mountUi() {
      this.host = document.createElement('div');
      this.host.style.cssText = `all: initial; position: fixed; inset: 0; pointer-events: none; z-index: ${MAX_Z};`;
      const shadow = this.host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `<style>${STYLE}</style><div class="box"><div class="chip"></div></div>`;
      this.box = shadow.querySelector('.box');
      this.chip = shadow.querySelector('.chip');
      if (window === window.top) {
        const banner = document.createElement('div');
        banner.className = 'banner';
        banner.innerHTML = 'Наведите на видео и кликните, чтобы улучшить · <kbd>Esc</kbd> — отмена';
        shadow.appendChild(banner);
      }
      document.documentElement.appendChild(this.host);

      this.cursorStyle = document.createElement('style');
      this.cursorStyle.textContent = '* { cursor: crosshair !important; }';
      document.documentElement.appendChild(this.cursorStyle);
    }

    isOwnNode = (node) => node === this.host;

    handleMove(e) {
      if (!e.isTrusted) return;
      this.lastPoint = { x: e.clientX, y: e.clientY, target: e.target };
      if (this.rafId) return;
      // Throttle hit-testing to one per frame.
      this.rafId = requestAnimationFrame(() => {
        this.rafId = 0;
        this.updateCandidate();
      });
    }

    updateCandidate() {
      if (!this.active || !this.lastPoint) return;
      const { x, y, target } = this.lastPoint;
      // The iframe's own picker handles hovering inside it.
      if (target instanceof HTMLIFrameElement) {
        this.highlight(null, false);
        return;
      }
      this.candidate = findVideoAt(x, y, this.isOwnNode, this.cache);
      this.highlight(this.candidate ?? (target instanceof Element ? target : null), !this.candidate);
    }

    highlight(node, miss) {
      if (!this.box) return;
      if (!node) {
        this.box.style.display = 'none';
        return;
      }
      const r = node.getBoundingClientRect();
      Object.assign(this.box.style, {
        display: 'block',
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      this.box.classList.toggle('miss', miss);
      this.chip.textContent = miss
        ? 'Здесь нет видео'
        : `▶ ${node.videoWidth || '?'}×${node.videoHeight || '?'} · кликните, чтобы улучшить`;
    }

    swallow(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    handleClick(e) {
      this.swallow(e);
      // Page scripts must not be able to pick a video on the user's behalf.
      if (!e.isTrusted) return;
      this.lastPoint = { x: e.clientX, y: e.clientY, target: e.target };
      this.updateCandidate();
      if (!this.candidate) return;
      const video = this.candidate;
      const { onPick } = this;
      this.stop();
      onPick(video);
    }

    handleKey(e) {
      if (e.key !== 'Escape' || !e.isTrusted) return;
      this.swallow(e);
      const { onCancel } = this;
      this.stop();
      onCancel();
    }
  }

  FSRX.Picker = Picker;
})();
