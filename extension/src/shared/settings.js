// Shared constants, presets and settings resolution.
// Loaded as a classic script by the popup, the service worker (importScripts)
// and the content scripts, so everything hangs off a single namespace.
(() => {
  const FSRX = (globalThis.FSRX ??= {});

  FSRX.MESSAGES = Object.freeze({
    PICKER_START: 'fsrx:picker-start',
    PICKER_STOP: 'fsrx:picker-stop',
    PICKER_DONE: 'fsrx:picker-done',
    PICKER_CANCEL: 'fsrx:picker-cancel',
    AUTO_START: 'fsrx:auto-start',
    SHADER_GET: 'fsrx:shader-get',
    SESSION_GET: 'fsrx:session-get',
    SESSION_DETACH: 'fsrx:session-detach',
    SESSION_STATE: 'fsrx:session-state',
    AUTO_CLAIM: 'fsrx:auto-claim',
  });

  // Chrome rejects sendMessage with these when no listener replies, which is
  // expected for broadcasts and for frames without a session.
  const EXPECTED_NO_RECEIVER = ['Receiving end does not exist', 'message port closed'];

  FSRX.isExpectedNoReceiver = (err) =>
    EXPECTED_NO_RECEIVER.some((text) => String(err?.message).includes(text));

  FSRX.errorMessage = (err) => err?.message || String(err);

  FSRX.formatSize = (w, h) => `${w}×${h}`;

  const formatFps = (fps) => String(Math.round(fps * 10) / 10);

  /**
   * Frame generation status shared by the HUD and the popup, e.g.
   * "×2 24 → 48 fps", or the state note; '' when there is nothing to say.
   * @param {{interpolating: boolean, sourceFps: number, dedup: boolean, note: string} | null} status
   */
  FSRX.formatFrameGen = (status) => {
    if (!status) return '';
    if (status.interpolating && status.sourceFps > 0) {
      const fps = `${formatFps(status.sourceFps)} → ${formatFps(status.sourceFps * 2)} fps`;
      return `×2 ${fps}${status.dedup ? ' · повторы пропускаются' : ''}`;
    }
    return status.note;
  };

  /**
   * Sends a message to the service worker; the worker reports failures as
   * {error}, which is turned back into a rejection here.
   */
  FSRX.sendToWorker = async (message) => {
    const response = await chrome.runtime.sendMessage(message);
    if (response?.error) throw new Error(response.error);
    return response;
  };

  /** Random hex id; crypto.randomUUID is unavailable on insecure (http) pages. */
  FSRX.randomToken = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

  FSRX.MODELS = Object.freeze({
    'fsrcnnx-8': Object.freeze({
      label: 'FSRCNNX 8',
      file: 'FSRCNNX_x2_8-0-4-1.glsl',
      cost: 'лёгкая',
    }),
    'fsrcnnx-16': Object.freeze({
      label: 'FSRCNNX 16',
      file: 'FSRCNNX_x2_16-0-4-1.glsl',
      cost: 'тяжёлая',
    }),
    'fsrcnnx-16-anime': Object.freeze({
      label: 'FSRCNNX 16 Аниме',
      file: 'FSRCNNX_x2_16-0-4-1_anime_enhance.glsl',
      cost: 'тяжёлая',
    }),
  });

  FSRX.SCALERS = Object.freeze({
    'catmull-rom': 'Catmull-Rom (чётче)',
    bilinear: 'Билинейное (быстрее)',
  });

  FSRX.PRESETS = Object.freeze({
    default: Object.freeze({
      label: 'Обычный',
      hint: 'Быстрый вариант для любого видео',
      model: 'fsrcnnx-8',
      sharpness: 0,
      antiring: 0.5,
      scaler: 'catmull-rom',
    }),
    anime: Object.freeze({
      label: 'Аниме',
      hint: 'Модель для рисованной графики, чёткие контуры',
      model: 'fsrcnnx-16-anime',
      sharpness: 0,
      // The "enhance" model draws dark outlines around line art; strong
      // anti-ringing tames them, short of full clamping, which also flattens
      // some of the line contrast the model adds.
      antiring: 0.6,
      scaler: 'catmull-rom',
    }),
    films: Object.freeze({
      label: 'Фильмы',
      hint: 'Тяжелее, естественная картинка, сохраняет зерно',
      model: 'fsrcnnx-16',
      sharpness: 0,
      antiring: 0.3,
      scaler: 'catmull-rom',
    }),
  });

  FSRX.CUSTOM_PRESET = 'custom';
  const PRESET_FIELDS = ['model', 'sharpness', 'antiring', 'scaler'];

  FSRX.DEFAULT_SETTINGS = Object.freeze({
    preset: 'default',
    model: FSRX.PRESETS.default.model,
    sharpness: FSRX.PRESETS.default.sharpness,
    antiring: FSRX.PRESETS.default.antiring,
    scaler: FSRX.PRESETS.default.scaler,
    compare: false,
    // Keeps the HUD on screen permanently.
    showHud: false,
    // FSRCNNX upscaling; independent of frame generation, so either can run alone.
    upscale: true,
    // Not preset fields: presets never toggle them, and toggling them never
    // turns the preset into "Custom".
    frameGen: false,
    // Repeated frames are neither re-upscaled nor interpolated; off sends
    // every frame through the full pipeline.
    skipDuplicates: false,
  });

  // Slider granularity (0.05); dividing by an integer keeps values exact
  // (0.15, not 0.15000000000000002) so presets still match after rounding.
  const SLIDER_STEPS_PER_UNIT = 20;

  /** Clamps an untrusted value to a 0..1 slider step, or returns the fallback. */
  function unitSlider(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.round(Math.min(1, Math.max(0, num)) * SLIDER_STEPS_PER_UNIT) / SLIDER_STEPS_PER_UNIT;
  }

  /** Returns the preset id whose values match the settings, or 'custom'. */
  FSRX.matchPreset = (settings) => {
    const found = Object.entries(FSRX.PRESETS).find(([, preset]) =>
      PRESET_FIELDS.every((field) => preset[field] === settings[field]),
    );
    return found ? found[0] : FSRX.CUSTOM_PRESET;
  };

  /** Coerces untrusted stored data into a valid settings object. */
  FSRX.sanitizeSettings = (raw) => {
    const src = raw && typeof raw === 'object' ? raw : {};
    const defaults = FSRX.DEFAULT_SETTINGS;
    const settings = {
      model: Object.hasOwn(FSRX.MODELS, src.model) ? src.model : defaults.model,
      scaler: Object.hasOwn(FSRX.SCALERS, src.scaler) ? src.scaler : defaults.scaler,
      sharpness: unitSlider(src.sharpness, defaults.sharpness),
      antiring: unitSlider(src.antiring, defaults.antiring),
      compare: src.compare === true,
      showHud: src.showHud === true,
      upscale: src.upscale !== false,
      frameGen: src.frameGen === true,
      skipDuplicates: src.skipDuplicates === true,
    };
    settings.preset = FSRX.matchPreset(settings);
    return settings;
  };

  /** Applies a preset's values on top of existing settings. */
  FSRX.applyPreset = (settings, presetId) => {
    const preset = FSRX.PRESETS[presetId];
    if (!preset) return settings;
    const values = Object.fromEntries(PRESET_FIELDS.map((field) => [field, preset[field]]));
    return FSRX.sanitizeSettings({ ...settings, ...values });
  };

  /**
   * Site key used to remember per-site state. Only http(s) pages are supported.
   * @param {string | undefined} url
   * @returns {string | null}
   */
  FSRX.siteKeyFromUrl = (url) => {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null;
    } catch {
      return null;
    }
  };

  const STORE_KEYS = ['globalEnabled', 'settings', 'sites'];
  FSRX.STORE_KEYS = STORE_KEYS;

  /** Reads the whole persisted store with defaults applied. */
  FSRX.loadStore = async () => {
    const raw = await chrome.storage.local.get(STORE_KEYS);
    return {
      globalEnabled: raw.globalEnabled !== false,
      settings: FSRX.sanitizeSettings(raw.settings),
      sites: raw.sites && typeof raw.sites === 'object' ? raw.sites : {},
    };
  };

  /**
   * Resolves the effective configuration for a site.
   * Site profile: { enabled?: boolean, autoStart?: boolean, settings?: object }.
   * Sites are opt-in: only an explicitly enabled site runs. A site without its
   * own settings follows the shared ones live, so editing them affects it too.
   */
  FSRX.resolveConfig = (store, siteKey) => {
    const site = (siteKey && Object.hasOwn(store.sites, siteKey) && store.sites[siteKey]) || {};
    const ownSettings = Boolean(site.settings);
    const siteEnabled = site.enabled === true;
    return {
      globalEnabled: store.globalEnabled,
      siteEnabled,
      enabled: store.globalEnabled && siteEnabled,
      autoStart: site.autoStart === true,
      ownSettings,
      settings: ownSettings ? FSRX.sanitizeSettings(site.settings) : store.settings,
    };
  };
})();
