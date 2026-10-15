// Popup controller. Storage is the single source of truth: the popup writes
// it, and content sessions react through chrome.storage.onChanged.
(() => {
  const {
    MESSAGES, MODELS, PRESETS, SCALERS, CUSTOM_PRESET,
    loadStore, resolveConfig, sanitizeSettings, applyPreset, siteKeyFromUrl, STORE_KEYS,
    isExpectedNoReceiver, sendToWorker, errorMessage, formatSize, formatFrameGen,
  } = globalThis.FSRX;

  const STATUS_POLL_MS = 1000;

  const $ = (id) => document.getElementById(id);
  const ui = {
    app: $('app'),
    globalEnabled: $('globalEnabled'),
    statusCard: $('statusCard'),
    statusTitle: $('statusTitle'),
    statusDetail: $('statusDetail'),
    detach: $('detach'),
    pick: $('pick'),
    siteCard: $('siteCard'),
    siteName: $('siteName'),
    siteEnabled: $('siteEnabled'),
    siteAutoStart: $('siteAutoStart'),
    siteOwnSettings: $('siteOwnSettings'),
    scope: $('scope'),
    presets: $('presets'),
    presetHint: $('presetHint'),
    compare: $('compare'),
    showHud: $('showHud'),
    upscale: $('upscale'),
    frameGen: $('frameGen'),
    skipDuplicates: $('skipDuplicates'),
    skipDuplicatesRow: $('skipDuplicatesRow'),
    model: $('model'),
    sharpness: $('sharpness'),
    sharpnessValue: $('sharpnessValue'),
    antiring: $('antiring'),
    antiringValue: $('antiringValue'),
    scaler: $('scaler'),
    error: $('error'),
    gpu: $('gpu'),
    version: $('version'),
    needsSite: document.querySelectorAll('.needs-site'),
    needsUpscale: document.querySelectorAll('.needs-upscale'),
    // Same selection as the .global-off CSS rule.
    globalParked: document.querySelectorAll('#app > :not(.header):not(.footer)'),
  };

  const state = {
    tabId: null,
    siteKey: null,
    store: null,
    session: null,
  };

  // ---- helpers -------------------------------------------------------------

  function showError(message) {
    ui.error.textContent = message;
    ui.error.hidden = !message;
  }

  /** Sends to the tab; resolves null when no frame owns a session. */
  async function sendToTab(message) {
    if (state.tabId === null) return null;
    try {
      return (await chrome.tabs.sendMessage(state.tabId, { ...message, siteKey: state.siteKey })) ?? null;
    } catch (err) {
      if (isExpectedNoReceiver(err)) return null;
      throw err;
    }
  }

  function fillSelect(select, entries) {
    select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
  }

  const sizeText = (s) => formatSize(s.w, s.h);

  // ---- storage writes ------------------------------------------------------

  /**
   * Persists a patch and applies it to the local snapshot immediately, so a
   * quick follow-up edit builds on it instead of on stale data.
   */
  async function persist(patch) {
    await chrome.storage.local.set(patch);
    Object.assign(state.store, patch);
    renderStore();
  }

  function siteProfile() {
    return { ...(state.store.sites[state.siteKey] ?? {}) };
  }

  /** Writes a site profile, dropping it entirely when it holds only defaults. */
  async function saveSiteProfile(profile) {
    const sites = { ...state.store.sites };
    const isDefault = !profile.enabled && !profile.autoStart && !profile.settings;
    if (isDefault) delete sites[state.siteKey];
    else sites[state.siteKey] = profile;
    await persist({ sites });
  }

  async function saveSettings(next) {
    const settings = sanitizeSettings(next);
    const config = resolveConfig(state.store, state.siteKey);
    if (config.ownSettings) {
      await saveSiteProfile({ ...siteProfile(), settings });
    } else {
      await persist({ settings });
    }
  }

  /**
   * Content scripts only arm auto-start on page load, so a switch that just
   * made it effective has to arm it in the open tab right away.
   */
  async function armAutoStartIfActive() {
    const config = resolveConfig(state.store, state.siteKey);
    if (!config.enabled || !config.autoStart) return;
    try {
      await sendToWorker({ type: MESSAGES.AUTO_START, tabId: state.tabId });
    } catch (err) {
      // The switch itself is already saved; only this tab refused injection
      // (e.g. pages Chrome closes to extensions), so say exactly that.
      throw new Error(`Настройка сохранена, но на этой странице автозапуск недоступен: ${errorMessage(err)}`);
    }
  }

  function currentSettings() {
    return resolveConfig(state.store, state.siteKey).settings;
  }

  // ---- rendering -----------------------------------------------------------

  function renderSettings(config) {
    const { settings } = config;
    for (const button of ui.presets.children) {
      button.setAttribute('aria-checked', String(button.dataset.preset === settings.preset));
    }
    ui.presetHint.textContent = settings.preset === CUSTOM_PRESET
      ? 'Свой — настроен в «Дополнительно»'
      : PRESETS[settings.preset].hint;
    ui.scope.textContent = config.ownSettings ? state.siteKey : 'Общие';
    ui.scope.classList.toggle('site-scope', config.ownSettings);
    ui.compare.checked = settings.compare;
    ui.showHud.checked = settings.showHud;
    ui.upscale.checked = settings.upscale;
    ui.app.classList.toggle('upscale-off', !settings.upscale);
    setParked(ui.needsUpscale, !settings.upscale);
    ui.frameGen.checked = settings.frameGen;
    ui.skipDuplicates.checked = settings.skipDuplicates;
    // Duplicates are detected on the interpolation path only.
    ui.skipDuplicatesRow.hidden = !settings.frameGen;
    ui.model.value = settings.model;
    ui.scaler.value = settings.scaler;
    renderSlider(ui.sharpness, ui.sharpnessValue, settings.sharpness);
    renderSlider(ui.antiring, ui.antiringValue, settings.antiring);
  }

  function renderSlider(input, output, value) {
    input.value = String(value);
    output.textContent = Number(value).toFixed(2);
    input.style.setProperty('--fill', `${Number(value) * 100}%`);
  }

  /** Live label updates while dragging; storage is written once on release. */
  function bindSlider(input, output, field) {
    input.addEventListener('input', () => renderSlider(input, output, input.value));
    input.addEventListener('change', guarded(() =>
      saveSettings({ ...currentSettings(), [field]: Number(input.value) })));
  }

  /**
   * Dimmed blocks only drop pointer events in CSS; inert also takes them out
   * of keyboard focus, so a parked switch can't be flipped with Tab + Space.
   */
  function setParked(elements, parked) {
    for (const element of elements) element.inert = parked;
  }

  function renderStore() {
    const config = resolveConfig(state.store, state.siteKey);
    ui.globalEnabled.checked = config.globalEnabled;
    ui.app.classList.toggle('global-off', !config.globalEnabled);
    setParked(ui.globalParked, !config.globalEnabled);
    ui.siteEnabled.checked = config.siteEnabled;
    ui.siteAutoStart.checked = config.autoStart;
    ui.siteOwnSettings.checked = config.ownSettings;
    ui.siteCard.classList.toggle('site-off', !config.siteEnabled);
    setParked(ui.needsSite, !config.siteEnabled);
    ui.pick.disabled = !state.siteKey || !config.enabled;
    renderSettings(config);
    renderStatus();
  }

  function setStatus(stateName, title, detail) {
    ui.statusCard.dataset.state = stateName;
    ui.statusTitle.textContent = title;
    ui.statusDetail.textContent = detail;
  }

  /** No session yet: explain why "Выбрать плеер" is unavailable, if it is. */
  function renderIdleStatus() {
    const config = resolveConfig(state.store, state.siteKey);
    if (!config.globalEnabled) {
      setStatus('idle', 'Расширение выключено', 'Включите главный выключатель вверху');
    } else if (!config.siteEnabled) {
      setStatus('idle', 'Выключено на этом сайте', 'Включите «Включено на этом сайте» ниже');
    } else {
      setStatus('idle', 'Видео не выбрано', 'Выберите плеер на странице');
    }
  }

  function renderStatus() {
    const s = state.session;
    ui.detach.hidden = !s;
    ui.statusDetail.title = '';
    if (!state.siteKey) {
      setStatus('idle', 'Здесь недоступно', 'Расширениям запрещён доступ к этой странице');
      return;
    }
    if (!s) {
      renderIdleStatus();
      return;
    }
    if (s.gpu) ui.gpu.textContent = `Видеокарта: ${s.gpu}`;
    ui.gpu.title = s.gpu ?? '';
    if (s.error) return setStatus('error', 'Ошибка', s.error);
    if (!s.enabled) return setStatus('paused', 'На паузе', `Подключено к видео ${sizeText(s.source)}`);
    const fgText = formatFrameGen(s.frameGen);
    const fgSuffix = fgText ? ` · ${fgText}` : '';
    if (s.upscale === false) {
      const why = s.upscaleSkippedLarge ? 'увеличение не нужно (1440p+)' : 'без увеличения';
      return setStatus('active', `Работает · ${s.fps} кадр/с`, `${sizeText(s.source)} · ${why}${fgSuffix}`);
    }
    if (s.loadingModel) return setStatus('loading', 'Подготовка шейдеров…', MODELS[s.loadingModel]?.label ?? '');
    const out = s.output ? sizeText(s.output) : '—';
    const fg = s.frameGen;
    ui.statusDetail.title = fg?.state === 'active'
      ? `Удвоение кадров: ${fg.textureMB} МБ видеопамяти под кадры, задержка картинки ${fg.latencyMs} мс`
      : '';
    if (!s.modelApplied) {
      return setStatus('paused', 'Без нейросети', `${sizeText(s.source)} → ${out} · плеер слишком мал для увеличения в 2 раза${fgSuffix}`);
    }
    const statusState = fg?.state === 'blocked' || fg?.state === 'error' ? 'paused' : 'active';
    setStatus(statusState, `Работает · ${s.fps} кадр/с`,
      `${sizeText(s.source)} → ${out} · ${MODELS[s.activeModel]?.label ?? ''}${fgSuffix}`);
  }

  async function refreshStatus() {
    try {
      state.session = await sendToTab({ type: MESSAGES.SESSION_GET });
    } catch (err) {
      state.session = null;
      showError(err.message);
    }
    renderStatus();
  }

  // ---- event wiring --------------------------------------------------------

  function buildControls() {
    ui.presets.replaceChildren(...Object.entries(PRESETS).map(([id, preset]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.role = 'radio';
      button.dataset.preset = id;
      button.textContent = preset.label;
      button.title = preset.hint;
      return button;
    }));
    fillSelect(ui.model, Object.entries(MODELS).map(([id, m]) => [id, `${m.label} · ${m.cost}`]));
    fillSelect(ui.scaler, Object.entries(SCALERS));
    ui.version.textContent = `v${chrome.runtime.getManifest().version}`;
  }

  /** Wraps async handlers so failures surface in the popup instead of vanishing. */
  const guarded = (fn) => (...args) => {
    showError('');
    Promise.resolve(fn(...args)).catch((err) => showError(errorMessage(err)));
  };

  function bindEvents() {
    ui.globalEnabled.addEventListener('change', guarded(async () => {
      await persist({ globalEnabled: ui.globalEnabled.checked });
      await armAutoStartIfActive();
    }));

    ui.siteEnabled.addEventListener('change', guarded(async () => {
      await saveSiteProfile({ ...siteProfile(), enabled: ui.siteEnabled.checked });
      await armAutoStartIfActive();
    }));

    ui.siteOwnSettings.addEventListener('change', guarded(() => {
      const profile = siteProfile();
      // Start the site preset from whatever is in effect right now.
      if (ui.siteOwnSettings.checked) profile.settings = { ...currentSettings() };
      else delete profile.settings;
      return saveSiteProfile(profile);
    }));

    ui.siteAutoStart.addEventListener('change', guarded(async () => {
      await saveSiteProfile({ ...siteProfile(), autoStart: ui.siteAutoStart.checked });
      await armAutoStartIfActive();
    }));

    ui.presets.addEventListener('click', guarded((e) => {
      const id = e.target.closest('button')?.dataset.preset;
      if (id) return saveSettings(applyPreset(currentSettings(), id));
    }));

    ui.compare.addEventListener('change', guarded(() =>
      saveSettings({ ...currentSettings(), compare: ui.compare.checked })));
    ui.upscale.addEventListener('change', guarded(() =>
      saveSettings({ ...currentSettings(), upscale: ui.upscale.checked })));
    ui.showHud.addEventListener('change', guarded(() =>
      saveSettings({ ...currentSettings(), showHud: ui.showHud.checked })));
    ui.frameGen.addEventListener('change', guarded(() =>
      saveSettings({ ...currentSettings(), frameGen: ui.frameGen.checked })));
    ui.skipDuplicates.addEventListener('change', guarded(() =>
      saveSettings({ ...currentSettings(), skipDuplicates: ui.skipDuplicates.checked })));

    ui.model.addEventListener('change', guarded(() =>
      saveSettings({ ...currentSettings(), model: ui.model.value })));
    ui.scaler.addEventListener('change', guarded(() =>
      saveSettings({ ...currentSettings(), scaler: ui.scaler.value })));
    bindSlider(ui.sharpness, ui.sharpnessValue, 'sharpness');
    bindSlider(ui.antiring, ui.antiringValue, 'antiring');

    ui.pick.addEventListener('click', guarded(async () => {
      await sendToWorker({ type: MESSAGES.PICKER_START, tabId: state.tabId });
      // Close so the page receives the next click.
      window.close();
    }));

    ui.detach.addEventListener('click', guarded(async () => {
      await sendToTab({ type: MESSAGES.SESSION_DETACH });
      await refreshStatus();
    }));

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !STORE_KEYS.some((key) => key in changes)) return;
      loadStore().then((store) => {
        state.store = store;
        renderStore();
      }).catch((err) => showError(err.message));
    });
  }

  async function init() {
    buildControls();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tabId = tab?.id ?? null;
    state.siteKey = siteKeyFromUrl(tab?.url);
    state.store = await loadStore();
    ui.siteName.textContent = state.siteKey ?? 'Неподдерживаемая страница';
    ui.siteCard.classList.toggle('unavailable', !state.siteKey);
    setParked(ui.siteCard.querySelectorAll('.row'), !state.siteKey);
    renderStore();
    bindEvents();
    await refreshStatus();
    setInterval(refreshStatus, STATUS_POLL_MS);
  }

  init().catch((err) => showError(errorMessage(err)));
})();
