// On-page overlay placed as a sibling of the <video>: canvas, HUD and the A/B
// divider live in a closed shadow root so page CSS cannot interfere.
(() => {
  const FSRX = (globalThis.FSRX ??= {});

  const SPLIT_MIN = 0.02;
  const SPLIT_MAX = 0.98;
  // Rects smaller than this are treated as hidden (e.g. a collapsed player).
  const MIN_VISIBLE_PX = 2;
  // Sub-pixel drift below this is ignored to avoid layout thrash every frame.
  const POSITION_EPSILON = 0.5;
  // Relative change in the host's rendered/layout scale that triggers a resize.
  const SCALE_EPSILON = 0.001;
  const HUD_FADE_MS = 250;
  // Keyboard step for the A/B divider (fraction of the width per arrow press).
  const SPLIT_KEY_STEP = 0.02;

  const STYLE = `
:host { all: initial; }
.root { position: absolute; inset: 0; pointer-events: none; overflow: hidden;
  font: 500 12px/1.35 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.hud { position: absolute; top: 12px; left: 12px; display: flex; gap: 10px; align-items: center;
  padding: 8px 12px 8px 10px; border-radius: 10px; color: #eef1f6;
  background: rgba(14, 16, 21, .72); border: 1px solid rgba(255,255,255,.08);
  backdrop-filter: blur(10px) saturate(1.4); box-shadow: 0 6px 24px rgba(0,0,0,.35);
  opacity: 0; transform: translateY(-4px); transition: opacity ${HUD_FADE_MS}ms ease, transform ${HUD_FADE_MS}ms ease; }
.hud.visible { opacity: 1; transform: none; }
.hud .dot { width: 8px; height: 8px; border-radius: 50%; flex: none;
  background: linear-gradient(135deg, #5eead4, #a78bfa); box-shadow: 0 0 10px #5eead4; }
.hud.warn .dot { background: #fbbf24; box-shadow: 0 0 10px #fbbf24; }
.hud.error .dot { background: #f87171; box-shadow: 0 0 10px #f87171; }
.hud .title { font-weight: 650; letter-spacing: .01em; }
.hud .line { color: #a9b1c3; font-variant-numeric: tabular-nums; }
.hud .line.dim { color: #7d8698; font-size: 11px; }
.hud .line.warn { color: #fbbf24; }
.hud .line.dim:not(.dim + .dim) { margin-top: 3px; }
.split { position: absolute; top: 0; bottom: 0; width: 0; display: none; }
.split.visible { display: block; }
.split .line { position: absolute; top: 0; bottom: 0; left: -1px; width: 2px;
  background: rgba(255,255,255,.9); box-shadow: 0 0 8px rgba(0,0,0,.6); }
.split .knob:focus-visible { outline: 2px solid #5eead4; outline-offset: 2px; }
.split .knob { position: absolute; top: 50%; left: -18px; width: 36px; height: 36px; margin-top: -18px;
  border-radius: 50%; background: rgba(14,16,21,.8); border: 2px solid #fff; color: #fff;
  display: grid; place-items: center; cursor: ew-resize; pointer-events: auto; touch-action: none;
  box-shadow: 0 4px 16px rgba(0,0,0,.5); font-size: 14px; user-select: none; }
.tag { position: absolute; top: 12px; padding: 3px 8px; border-radius: 6px; color: #fff;
  background: rgba(14,16,21,.7); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; display: none; }
.tag.visible { display: block; }
.tag.left { left: 12px; }
.tag.right { right: 12px; }
.hud.with-tags { top: 40px; }
`;

  /**
   * Offset of the picture inside the free space for one object-position
   * component. Computed values are resolved to "<n>%" or "<n>px"; anything
   * else (e.g. calc()) falls back to centring.
   */
  function alignOffset(token, free) {
    const value = parseFloat(token);
    if (!Number.isFinite(value)) return free / 2;
    if (token.endsWith('%')) return (free * value) / 100;
    if (token.endsWith('px')) return value;
    return free / 2;
  }

  /** Object-fit scale factors of the picture inside its content box. */
  function fitScale(objectFit, box, vw, vh) {
    const contain = Math.min(box.w / vw, box.h / vh);
    switch (objectFit) {
      case 'fill': return { sx: box.w / vw, sy: box.h / vh };
      case 'cover': {
        const s = Math.max(box.w / vw, box.h / vh);
        return { sx: s, sy: s };
      }
      case 'none': return { sx: 1, sy: 1 };
      case 'scale-down': {
        const s = Math.min(1, contain);
        return { sx: s, sy: s };
      }
      default: return { sx: contain, sy: contain };
    }
  }

  /**
   * Computes the on-screen picture rectangle of a video and the matching
   * normalized crop of the source frame. Object-fit math runs in the video's
   * own layout units, then everything is mapped to viewport pixels using the
   * ratio between its rendered and layout size, so CSS transforms (scale) and
   * zoom on the video or any ancestor are honoured. Rotation/skew is not.
   * @param {HTMLVideoElement} video
   */
  function computeVideoGeometry(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !video.offsetWidth || !video.offsetHeight) return null;
    const rect = video.getBoundingClientRect();
    const scaleX = rect.width / video.offsetWidth;
    const scaleY = rect.height / video.offsetHeight;
    const style = getComputedStyle(video);
    const px = (v) => parseFloat(v) || 0;

    // Content box relative to the video's border-box origin, in layout units.
    const box = {
      x: px(style.borderLeftWidth) + px(style.paddingLeft),
      y: px(style.borderTopWidth) + px(style.paddingTop),
      w: video.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
      h: video.clientHeight - px(style.paddingTop) - px(style.paddingBottom),
    };
    if (box.w < MIN_VISIBLE_PX || box.h < MIN_VISIBLE_PX) return null;

    const { sx, sy } = fitScale(style.objectFit, box, vw, vh);
    const [posX = '50%', posY = '50%'] = style.objectPosition.split(' ');
    const drawn = { w: vw * sx, h: vh * sy };
    drawn.x = box.x + alignOffset(posX, box.w - drawn.w);
    drawn.y = box.y + alignOffset(posY, box.h - drawn.h);

    const left = Math.max(drawn.x, box.x);
    const top = Math.max(drawn.y, box.y);
    const visible = {
      x: left,
      y: top,
      w: Math.min(drawn.x + drawn.w, box.x + box.w) - left,
      h: Math.min(drawn.y + drawn.h, box.y + box.h) - top,
    };
    const crop = {
      x: (visible.x - drawn.x) / drawn.w,
      y: (visible.y - drawn.y) / drawn.h,
      w: visible.w / drawn.w,
      h: visible.h / drawn.h,
    };
    const toViewport = (r) => ({
      x: rect.left + r.x * scaleX,
      y: rect.top + r.y * scaleY,
      w: r.w * scaleX,
      h: r.h * scaleY,
    });
    return { visible: toViewport(visible), drawn: toViewport(drawn), crop, zIndex: style.zIndex };
  }

  function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    parent.appendChild(node);
    return node;
  }

  class Overlay {
    /**
     * @param {HTMLVideoElement} video
     * @param {{onSplitChange: (split: number) => void}} callbacks
     */
    constructor(video, { onSplitChange }) {
      this.video = video;
      this.onSplitChange = onSplitChange;
      this.split = 0.5;
      this.compare = false;
      this.hudTimer = 0;
      // Host geometry in its own layout units, plus the last measured
      // rendered/layout scale of its coordinate space (ancestor transforms, zoom).
      this.pos = { left: 0, top: 0, w: 0, h: 0, scaleX: 1, scaleY: 1 };

      this.host = document.createElement('div');
      this.host.setAttribute('data-fsrcnnx-overlay', '');
      this.host.style.cssText = 'all: initial; position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; display: block;';
      const shadow = this.host.attachShadow({ mode: 'closed' });
      el('style', '', shadow).textContent = STYLE;
      const root = el('div', 'root', shadow);
      this.canvas = el('canvas', '', root);
      this.tagLeft = el('div', 'tag left', root);
      this.tagLeft.textContent = 'Оригинал';
      this.tagRight = el('div', 'tag right', root);
      this.tagRight.textContent = 'Результат';
      this.splitEl = el('div', 'split', root);
      el('div', 'line', this.splitEl);
      this.knob = el('div', 'knob', this.splitEl);
      this.knob.textContent = '⟷';
      this.knob.tabIndex = 0;
      this.knob.setAttribute('role', 'slider');
      this.knob.setAttribute('aria-label', 'Разделитель: оригинал / результат');
      this.knob.title = 'Перетащите или используйте стрелки ← →';
      this.knob.setAttribute('aria-valuemin', '0');
      this.knob.setAttribute('aria-valuemax', '100');
      this.hud = el('div', 'hud', root);
      el('div', 'dot', this.hud);
      const hudText = el('div', '', this.hud);
      this.hudTitle = el('div', 'title', hudText);
      this.hudLines = el('div', '', hudText);

      this.bindDrag();
      this.attachHost();
    }

    /** (Re)inserts the host right after the video, e.g. after a framework re-render dropped it. */
    attachHost() {
      if (this.host.previousSibling !== this.video) this.video.after(this.host);
    }

    /** Keeps the overlay right above the video but below player controls. */
    syncZIndex(zIndex) {
      const value = zIndex === 'auto' ? '' : zIndex;
      if (this.host.style.zIndex !== value) this.host.style.zIndex = value;
    }

    bindDrag() {
      const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
      const move = (e) => {
        const rect = this.host.getBoundingClientRect();
        if (rect.width <= 0) return;
        this.setSplit((e.clientX - rect.left) / rect.width);
        this.onSplitChange(this.split);
      };
      this.knob.addEventListener('pointerdown', (e) => {
        stop(e);
        this.knob.setPointerCapture(e.pointerId);
        this.knob.addEventListener('pointermove', move);
      });
      const release = (e) => {
        stop(e);
        this.knob.removeEventListener('pointermove', move);
      };
      this.knob.addEventListener('pointerup', release);
      this.knob.addEventListener('pointercancel', release);
      this.knob.addEventListener('keydown', (e) => {
        const delta = { ArrowLeft: -SPLIT_KEY_STEP, ArrowRight: SPLIT_KEY_STEP }[e.key];
        if (!delta) return;
        stop(e);
        this.setSplit(this.split + delta);
        this.onSplitChange(this.split);
      });
      // Keep clicks on the knob from toggling playback in the player beneath.
      for (const type of ['click', 'dblclick', 'mousedown', 'mouseup']) {
        this.knob.addEventListener(type, stop);
      }
    }

    setSplit(value) {
      this.split = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
      this.splitEl.style.left = `${this.split * 100}%`;
      this.knob.setAttribute('aria-valuenow', String(Math.round(this.split * 100)));
    }

    setCompare(enabled) {
      this.compare = enabled;
      this.splitEl.classList.toggle('visible', enabled);
      this.tagLeft.classList.toggle('visible', enabled);
      this.tagRight.classList.toggle('visible', enabled);
      this.hud.classList.toggle('with-tags', enabled);
      this.setSplit(this.split);
    }

    /** Split value for the shader; negative disables the comparison. */
    get shaderSplit() {
      return this.compare ? this.split : -1;
    }

    setVisible(visible) {
      // visibility (not display) keeps the host measurable for place().
      this.host.style.visibility = visible ? 'visible' : 'hidden';
    }

    /**
     * Shows the HUD. With durationMs = 0 it stays until hidden explicitly.
     * @param {{title: string, lines: Array<{text: string, warn?: boolean, dim?: boolean}>,
     *   level?: 'ok' | 'warn' | 'error'}} content - one parameter per line; warn lines in
     *   orange, dim lines (live statistics) smaller and grey
     * @param {number} durationMs
     */
    showHud({ title, lines, level = 'ok' }, durationMs) {
      this.hudTitle.textContent = title;
      this.renderLines(lines);
      this.hud.classList.toggle('warn', level === 'warn');
      this.hud.classList.toggle('error', level === 'error');
      this.hud.classList.add('visible');
      clearTimeout(this.hudTimer);
      if (durationMs > 0) this.hudTimer = setTimeout(() => this.hideHud(), durationMs);
    }

    /** Rebuilds the HUD lines (once a second at most, so plain DOM nodes are fine). */
    renderLines(lines) {
      this.hudLines.replaceChildren(...lines.map((line) => {
        const node = document.createElement('div');
        node.className = `line${line.dim ? ' dim' : ''}${line.warn ? ' warn' : ''}`;
        node.textContent = line.text;
        return node;
      }));
    }

    hideHud() {
      clearTimeout(this.hudTimer);
      this.hud.classList.remove('visible');
    }

    get hudVisible() {
      return this.hud.classList.contains('visible');
    }

    /**
     * Aligns the overlay with the visible picture and sizes the canvas backing
     * store in device pixels.
     * @returns {{outW: number, outH: number, frameW: number, frameH: number, crop: object} | null}
     */
    updateLayout() {
      const geometry = computeVideoGeometry(this.video);
      if (!geometry || geometry.visible.w < MIN_VISIBLE_PX || geometry.visible.h < MIN_VISIBLE_PX) {
        return null;
      }
      const { visible, crop, drawn, zIndex } = geometry;
      this.place(visible);
      this.syncZIndex(zIndex);

      const dpr = window.devicePixelRatio || 1;
      const outW = Math.max(1, Math.round(visible.w * dpr));
      const outH = Math.max(1, Math.round(visible.h * dpr));
      if (this.canvas.width !== outW) this.canvas.width = outW;
      if (this.canvas.height !== outH) this.canvas.height = outH;
      // Size of the whole scaled frame (larger than the canvas for object-fit:
      // cover); this is mpv's OUTPUT and decides whether upscaling is worth it.
      const frameW = Math.round(drawn.w * dpr);
      const frameH = Math.round(drawn.h * dpr);
      return { outW, outH, frameW, frameH, crop };
    }

    /**
     * Positions the host over a viewport rect regardless of which ancestor is
     * its containing block or how that ancestor is scaled: measure where the
     * host landed and correct by the delta, converted to the host's layout units.
     */
    place(target) {
      const { pos, host } = this;
      this.applySize(target.w / pos.scaleX, target.h / pos.scaleY);
      let actual = host.getBoundingClientRect();
      const scaleX = pos.w > 0 && actual.width > 0 ? actual.width / pos.w : pos.scaleX;
      const scaleY = pos.h > 0 && actual.height > 0 ? actual.height / pos.h : pos.scaleY;
      if (Math.abs(scaleX / pos.scaleX - 1) > SCALE_EPSILON || Math.abs(scaleY / pos.scaleY - 1) > SCALE_EPSILON) {
        pos.scaleX = scaleX;
        pos.scaleY = scaleY;
        this.applySize(target.w / scaleX, target.h / scaleY);
        actual = host.getBoundingClientRect();
      }
      const dx = (target.x - actual.left) / pos.scaleX;
      const dy = (target.y - actual.top) / pos.scaleY;
      if (Math.abs(dx) > POSITION_EPSILON || Math.abs(dy) > POSITION_EPSILON) {
        pos.left += dx;
        pos.top += dy;
        host.style.left = `${pos.left}px`;
        host.style.top = `${pos.top}px`;
      }
    }

    /** Sets the host size in its own layout units, skipping sub-pixel changes. */
    applySize(w, h) {
      const { pos, host } = this;
      if (Math.abs(pos.w - w) <= POSITION_EPSILON && Math.abs(pos.h - h) <= POSITION_EPSILON) return;
      pos.w = w;
      pos.h = h;
      host.style.width = `${w}px`;
      host.style.height = `${h}px`;
    }

    destroy() {
      clearTimeout(this.hudTimer);
      this.host.remove();
    }
  }

  FSRX.Overlay = Overlay;
})();
