// Content entry point (one instance per frame): routes messages, owns the
// picker, the active session and the auto-start watcher.
(() => {
  const FSRX = (globalThis.FSRX ??= {});
  if (FSRX.ready) return;
  FSRX.ready = true;

  const { MESSAGES, Picker, Session, loadStore, resolveConfig, sendToWorker, STORE_KEYS } = FSRX;
  const { findMainPlayingVideo, isAutoCandidate } = FSRX.videoFinder;

  // Media events from videos inside shadow roots never reach document
  // listeners, so auto-start also polls at this interval while idle.
  const AUTO_POLL_MS = 2000;

  const picker = new Picker();
  /** @type {Session | null} */
  let session = null;
  /** Top-level site key, provided by the service worker (iframes can't see it). */
  let siteKey = null;
  /** Bumped on every attach so a slower, older attach can't overwrite a newer one. */
  let attachGeneration = 0;
  /** Set synchronously so overlapping auto-start triggers run one at a time. */
  let autoPending = false;
  let autoPollTimer = 0;
  /** Videos that failed or were detached by the user: auto-start leaves them alone. */
  const skippedVideos = new WeakSet();

  /** Set once this copy has lost its extension (reloaded or updated). */
  let orphaned = false;

  /**
   * After an extension reload or update the old content script keeps running
   * in the page, but every chrome.* call fails with "Extension context
   * invalidated". The fresh copy is injected separately, so this one just
   * stops quietly.
   * @returns {boolean} true when the extension context is gone
   */
  function checkOrphaned() {
    if (orphaned) return true;
    if (chrome.runtime?.id) return false;
    orphaned = true;
    stopAutoWatch();
    picker.stop();
    const ended = session;
    session = null;
    ended?.destroy();
    return true;
  }

  const logError = (context) => (err) => {
    if (checkOrphaned()) return;
    console.error(`[FSRCNNX] ${context}`, err);
  };

  function notifyState() {
    if (checkOrphaned()) return;
    sendToWorker({
      type: MESSAGES.SESSION_STATE,
      active: Boolean(session),
      enabled: Boolean(session?.enabled),
    }).catch(logError('state update failed'));
  }

  async function currentConfig() {
    return resolveConfig(await loadStore(), siteKey);
  }

  function onSessionEnd(ended) {
    if (ended.failed) skippedVideos.add(ended.video);
    if (session !== ended) return;
    session = null;
    notifyState();
  }

  /**
   * Replaces the current session with one for `video` (not started yet).
   * @returns {Promise<Session | null>} null when a newer attach superseded this one
   */
  async function attach(video) {
    if (session?.video === video && !session.failed) return session;
    const generation = ++attachGeneration;
    const config = await currentConfig();
    if (generation !== attachGeneration) return null;
    session?.destroy();
    session = new Session(video, config, { onEnd: onSessionEnd });
    notifyState();
    return session;
  }

  async function pick(video) {
    const created = await attach(video);
    if (!created) return;
    // Release the pickers in other frames before the (slow) shader compile.
    await sendToWorker({ type: MESSAGES.PICKER_DONE, token: created.token });
    await created.start();
  }

  function startPicker() {
    picker.start({
      onPick: (video) => {
        pick(video).catch(logError('attach failed'));
      },
      onCancel: () => {
        sendToWorker({ type: MESSAGES.PICKER_CANCEL }).catch(logError('cancel failed'));
      },
    });
  }

  /** Another frame won the pick: stop picking and drop any older session here. */
  function stopPicker(winnerToken) {
    picker.stop();
    if (winnerToken && session && session.token !== winnerToken) session.destroy();
  }

  async function tryAutoAttach(candidate) {
    if (session || autoPending || picker.active) return;
    autoPending = true;
    try {
      const config = await currentConfig();
      if (!config.enabled || !config.autoStart) return;
      const target = candidate && isAutoCandidate(candidate) && !skippedVideos.has(candidate)
        ? candidate
        : findMainPlayingVideo(skippedVideos);
      if (!target || session) return;
      // One auto session per tab: the worker arbitrates between frames.
      const { granted } = await sendToWorker({ type: MESSAGES.AUTO_CLAIM, enabled: config.enabled });
      if (!granted || session) return;
      const created = await attach(target);
      if (created) await created.start();
      else notifyState();
    } finally {
      autoPending = false;
    }
  }

  function onMediaPlaying(e) {
    tryAutoAttach(e.target).catch(logError('auto-start failed'));
  }

  function startAutoWatch() {
    if (!autoPollTimer) {
      // Media events do not bubble, but they do reach capture listeners on document.
      document.addEventListener('playing', onMediaPlaying, true);
      autoPollTimer = setInterval(() => {
        if (checkOrphaned()) return;
        if (!session) tryAutoAttach(null).catch(logError('auto-start failed'));
      }, AUTO_POLL_MS);
    }
    tryAutoAttach(null).catch(logError('auto-start failed'));
  }

  function stopAutoWatch() {
    document.removeEventListener('playing', onMediaPlaying, true);
    clearInterval(autoPollTimer);
    autoPollTimer = 0;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !STORE_KEYS.some((key) => key in changes)) return;
    currentConfig().then((config) => {
      if (!config.autoStart || !config.enabled) stopAutoWatch();
      if (session) {
        session.applyConfig(config);
        notifyState();
      }
    }).catch(logError('settings update failed'));
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (typeof message?.siteKey === 'string') siteKey = message.siteKey;
    switch (message?.type) {
      case MESSAGES.PICKER_START:
        startPicker();
        return false;
      case MESSAGES.PICKER_STOP:
        stopPicker(message.winner);
        return false;
      case MESSAGES.AUTO_START:
        startAutoWatch();
        return false;
      case MESSAGES.SESSION_GET:
        // Only the frame that owns a session answers; others stay silent.
        if (!session) return false;
        sendResponse(session.getStatus());
        return false;
      case MESSAGES.SESSION_DETACH:
        if (!session) return false;
        skippedVideos.add(session.video);
        session.destroy();
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });
})();
