// Locating <video> elements under the cursor, inside a picked player element,
// or (for auto-start) the main playing video of the page. Open shadow roots
// are searched too because many players are web components.
(() => {
  const FSRX = (globalThis.FSRX ??= {});

  // How far up from the hovered element we look for a containing player.
  const MAX_ANCESTOR_DEPTH = 6;
  // Ignore tiny previews/thumbnails when auto-starting.
  const MIN_AUTO_AREA = 320 * 180;

  function isVideo(node) {
    return node instanceof HTMLVideoElement;
  }

  function visibleArea(video) {
    const r = video.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  }

  /** Every element hit at a point, descending into open shadow roots. */
  function deepElementsFromPoint(x, y, root = document, seen = new Set()) {
    const result = [];
    for (const node of root.elementsFromPoint(x, y)) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (node.shadowRoot) result.push(...deepElementsFromPoint(x, y, node.shadowRoot, seen));
      result.push(node);
    }
    return result;
  }

  /** All videos below a root, including inside open shadow roots. */
  function queryVideosDeep(root) {
    const videos = [...root.querySelectorAll('video')];
    if (isVideo(root)) videos.push(root);
    for (const node of root.querySelectorAll('*')) {
      if (node.shadowRoot) videos.push(...queryVideosDeep(node.shadowRoot));
    }
    return videos;
  }

  function largest(videos, minArea = 1) {
    let best = null;
    let bestArea = minArea - 1;
    for (const video of videos) {
      const area = visibleArea(video);
      if (area > bestArea) {
        best = video;
        bestArea = area;
      }
    }
    return best;
  }

  /**
   * Resolves the video the user means when pointing at (x, y): a video directly
   * under the cursor wins, otherwise the largest video inside the nearest
   * ancestor of the hovered element that contains one.
   * @param {number} x
   * @param {number} y
   * @param {(node: Element) => boolean} ignore - filters out our own UI
   * @param {WeakMap<Element, HTMLVideoElement | null>} cache - memoizes the
   *   subtree search, which is expensive on big pages and runs on mousemove
   */
  function findVideoAt(x, y, ignore, cache) {
    const hits = deepElementsFromPoint(x, y).filter((node) => !ignore(node));
    const direct = hits.find(isVideo);
    if (direct) return direct;

    const top = hits[0];
    if (!top) return null;
    if (!cache.has(top)) cache.set(top, findVideoAround(top));
    return cache.get(top);
  }

  function parentAcrossShadow(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function findVideoAround(start) {
    let node = start;
    for (let depth = 0; node && depth <= MAX_ANCESTOR_DEPTH; depth++) {
      const found = largest(queryVideosDeep(node));
      if (found) return found;
      node = parentAcrossShadow(node);
    }
    return null;
  }

  /**
   * The largest visible video that is currently playing, for auto-start.
   * @param {WeakSet<HTMLVideoElement>} excluded - videos auto-start must skip
   */
  function findMainPlayingVideo(excluded) {
    const playing = queryVideosDeep(document).filter((v) =>
      !v.paused && !v.ended && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !excluded.has(v));
    return largest(playing, MIN_AUTO_AREA);
  }

  function isAutoCandidate(video) {
    return isVideo(video) && visibleArea(video) >= MIN_AUTO_AREA;
  }

  FSRX.videoFinder = { findVideoAt, findMainPlayingVideo, isAutoCandidate, visibleArea };
})();
