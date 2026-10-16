// Service worker: injects content scripts on demand, relays picker events
// between frames, arbitrates auto-start, serves bundled shaders and keeps the
// toolbar badge in sync.
importScripts('/src/shared/settings.js');

const {
  MESSAGES, MODELS, siteKeyFromUrl, loadStore, resolveConfig, isExpectedNoReceiver, errorMessage,
} = globalThis.FSRX;

const CONTENT_FILES = [
  'src/shared/settings.js',
  'src/content/mpv-hook.js',
  'src/content/gpu.js',
  'src/content/wgsl-passes.js',
  'src/content/wgsl-hook.js',
  'src/content/renderer.js',
  'src/content/frame-diff.js',
  'src/content/framegen.js',
  'src/content/interpolator.js',
  'src/content/frame-scheduler.js',
  'src/content/budget-guard.js',
  'src/content/interp-controller.js',
  'src/content/overlay.js',
  'src/content/video-finder.js',
  'src/content/picker.js',
  'src/content/session.js',
  'src/content/main.js',
];

const POPUP_URL_PREFIX = chrome.runtime.getURL('src/popup/');

const BADGE = {
  on: { text: 'ВКЛ', color: '#14b8a6' },
  off: { text: 'ВЫКЛ', color: '#64748b' },
};

/** Shader sources are immutable, so they are cached for the worker's lifetime. */
const shaderCache = new Map();

async function broadcast(tabId, message, options) {
  try {
    await chrome.tabs.sendMessage(tabId, message, options);
  } catch (err) {
    // Broadcasts don't expect replies; anything else is a real failure.
    if (!isExpectedNoReceiver(err)) throw err;
  }
}

/**
 * Injects the content scripts into frames that don't have them yet.
 * @param {number} tabId
 * @param {number[] | undefined} frameIds - all frames when omitted
 */
async function ensureInjected(tabId, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  const probes = await chrome.scripting.executeScript({
    target,
    func: () => Boolean(globalThis.FSRX?.ready),
  });
  const missing = probes.filter((p) => !p.result).map((p) => p.frameId);
  if (missing.length === 0) return;
  await chrome.scripting.executeScript({ target: { tabId, frameIds: missing }, files: CONTENT_FILES });
}

async function getShader(modelId) {
  if (!Object.hasOwn(MODELS, modelId)) throw new Error('Неизвестная модель');
  if (!shaderCache.has(modelId)) {
    const response = await fetch(chrome.runtime.getURL(`shaders/${MODELS[modelId].file}`));
    if (!response.ok) throw new Error(`Нет файла шейдера (${response.status})`);
    shaderCache.set(modelId, await response.text());
  }
  return shaderCache.get(modelId);
}

// ---- per-tab session registry ----------------------------------------------
// Per tab: which frames own a session ({[frameId]: enabled}) and which site the
// tab keeps "following" (the session's video was replaced, e.g. by the next
// episode, so the next main video is picked up even without auto-start).
// Lives in storage.session because the worker may be terminated between
// events, and updates are serialized so concurrent claims can't both win.

const REGISTRY_KEY = 'tabSessions';
let registryQueue = Promise.resolve();

/**
 * @typedef {{frames: Record<string, boolean>, follow: string | null}} TabEntry
 */

async function readRegistry() {
  const { [REGISTRY_KEY]: registry = {} } = await chrome.storage.session.get(REGISTRY_KEY);
  return registry;
}

/** @returns {TabEntry} */
function copyEntry(stored) {
  return { frames: { ...(stored?.frames ?? {}) }, follow: stored?.follow ?? null };
}

/**
 * Runs `mutate(entry)` on one tab's entry under the registry lock.
 * @template T
 * @param {number} tabId
 * @param {(entry: TabEntry) => T} mutate
 * @returns {Promise<T>}
 */
function updateTab(tabId, mutate) {
  const run = async () => {
    const registry = await readRegistry();
    const entry = copyEntry(registry[tabId]);
    const result = mutate(entry);
    if (Object.keys(entry.frames).length > 0 || entry.follow) registry[tabId] = entry;
    else delete registry[tabId];
    await chrome.storage.session.set({ [REGISTRY_KEY]: registry });
    await renderBadge(tabId, entry.frames);
    return result;
  };
  const next = registryQueue.then(run, run);
  registryQueue = next.catch(() => { /* keep the queue alive; the caller gets the error */ });
  return next;
}

async function readFollow(tabId) {
  return (await readRegistry())[tabId]?.follow ?? null;
}

async function renderBadge(tabId, frames) {
  const states = Object.values(frames);
  const badge = states.length === 0 ? null : (states.some(Boolean) ? BADGE.on : BADGE.off);
  try {
    await chrome.action.setBadgeText({ tabId, text: badge?.text ?? '' });
    if (badge) await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
  } catch (err) {
    // The tab may have closed in the meantime; its badge no longer matters.
    if (!String(err?.message).includes('No tab with id')) throw err;
  }
}

/** Top-level navigation: frames are gone, following survives only on the same site. */
function resetTab(tabId, siteKey) {
  return updateTab(tabId, (entry) => {
    entry.frames = {};
    if (entry.follow !== siteKey) entry.follow = null;
  });
}

function forgetTab(tabId) {
  return updateTab(tabId, (entry) => {
    entry.frames = {};
    entry.follow = null;
  });
}

function removeFrame(tabId, frameId) {
  return updateTab(tabId, (entry) => {
    delete entry.frames[frameId];
  });
}

/**
 * Session state reported by a frame. An active session makes the tab follow
 * its site; a session closed on purpose (detached, failed) stops that unless
 * another frame still has one.
 */
function setFrameState(tabId, frameId, siteKey, { active, enabled, follow }) {
  return updateTab(tabId, (entry) => {
    if (active) {
      entry.frames[frameId] = enabled;
      entry.follow = siteKey;
      return;
    }
    delete entry.frames[frameId];
    if (!follow && Object.keys(entry.frames).length === 0) entry.follow = null;
  });
}

/**
 * Frames removed from the page (an iframe player replaced with a new one)
 * send no navigation event, so their registry entries are checked here.
 */
async function liveFrameIds(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  return new Set((frames ?? []).map((frame) => String(frame.frameId)));
}

/** Grants auto-start to a frame only if no other live frame of the tab has a session. */
async function claimAutoSession(tabId, frameId, enabled) {
  const live = await liveFrameIds(tabId);
  return updateTab(tabId, (entry) => {
    for (const id of Object.keys(entry.frames)) {
      if (!live.has(id)) delete entry.frames[id];
    }
    const othersActive = Object.keys(entry.frames).some((id) => Number(id) !== frameId);
    if (othersActive) return { granted: false };
    entry.frames[frameId] = enabled;
    return { granted: true };
  });
}

// ---- actions ---------------------------------------------------------------

async function startPicker(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const siteKey = siteKeyFromUrl(tab.url);
  if (!siteKey) throw new Error('Расширениям запрещён доступ к этой странице');
  await ensureInjected(tabId);
  await broadcast(tabId, { type: MESSAGES.PICKER_START, siteKey });
}

/**
 * Injects into the given frames (or all) of a tab and arms auto-start there,
 * if the tab's site has auto-start enabled or the tab follows this site.
 */
async function autoStart(tabId, frameIds) {
  const tab = await chrome.tabs.get(tabId);
  const siteKey = siteKeyFromUrl(tab.url);
  if (!siteKey) return;
  const config = resolveConfig(await loadStore(), siteKey);
  const follow = (await readFollow(tabId)) === siteKey;
  if (!config.enabled || !(config.autoStart || follow)) return;
  await ensureInjected(tabId, frameIds);
  const message = { type: MESSAGES.AUTO_START, siteKey, follow };
  if (!frameIds) {
    await broadcast(tabId, message);
    return;
  }
  await Promise.all(frameIds.map((frameId) => broadcast(tabId, message, { frameId })));
}

// ---- messaging -------------------------------------------------------------

/** Messages the popup may send. */
const popupHandlers = new Map([
  [MESSAGES.PICKER_START, (message) => startPicker(Number(message.tabId))],
  [MESSAGES.AUTO_START, (message) => autoStart(Number(message.tabId))],
]);

/** Messages content scripts may send; `sender.tab` is guaranteed. */
const contentHandlers = new Map([
  [MESSAGES.PICKER_DONE, (message, sender) =>
    broadcast(sender.tab.id, { type: MESSAGES.PICKER_STOP, winner: String(message.token) })],
  [MESSAGES.PICKER_CANCEL, (_message, sender) =>
    broadcast(sender.tab.id, { type: MESSAGES.PICKER_STOP, winner: null })],
  [MESSAGES.SHADER_GET, (message) => getShader(message.modelId).then((source) => ({ source }))],
  [MESSAGES.SESSION_STATE, (message, sender) =>
    setFrameState(sender.tab.id, sender.frameId, siteKeyFromUrl(sender.tab.url), {
      active: Boolean(message.active),
      enabled: Boolean(message.enabled),
      follow: Boolean(message.follow),
    })],
  [MESSAGES.AUTO_CLAIM, (message, sender) =>
    claimAutoSession(sender.tab.id, sender.frameId, Boolean(message.enabled))],
]);

function resolveHandler(message, sender) {
  if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string') return null;
  if (sender.url?.startsWith(POPUP_URL_PREFIX)) return popupHandlers.get(message.type) ?? null;
  if (sender.tab) return contentHandlers.get(message.type) ?? null;
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = resolveHandler(message, sender);
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message, sender))
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((err) => sendResponse({ error: errorMessage(err) }));
  return true;
});

// ---- navigation ------------------------------------------------------------

function reportBackgroundError(context) {
  return (err) => {
    // Frames and tabs can vanish between an event and our follow-up call.
    if (/No (frame|tab) with id/.test(String(err?.message))) return;
    console.error(`[FSRCNNX] ${context}`, err);
  };
}

// A navigated frame loses its session (the content script dies with it).
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  const reset = frameId === 0 ? resetTab(tabId, siteKeyFromUrl(url)) : removeFrame(tabId, frameId);
  reset.catch(reportBackgroundError('session reset'));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId).catch(reportBackgroundError('tab cleanup'));
});

// Covers the top document and players inside (possibly late-loaded) iframes.
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId, url }) => {
  if (!siteKeyFromUrl(url)) return;
  autoStart(tabId, [frameId]).catch(reportBackgroundError('auto-start'));
});
