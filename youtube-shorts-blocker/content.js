(() => {
  "use strict";

  const SHORTS_PATH = /^\/shorts(?:\/|$)/i;
  const WATCH_PATH = /^\/watch$/i;
  const BLOCKED_ATTRIBUTE = "data-shorts-blocked";
  const CAPTURE_OPTIONS = { capture: true, passive: false };
  const MAX_VIDEO_ERROR_RELOADS = 1;
  const VIDEO_ERROR_RELOAD_WINDOW_MS = 10 * 60 * 1000;
  const VIDEO_ERROR_STABLE_MS = 6000;
  const VIDEO_ERROR_POST_RELOAD_GRACE_MS = 30000;
  const VIDEO_ERROR_STARTUP_CHECK_MS = 30000;
  const VIDEO_ERROR_STARTUP_CHECK_INTERVAL_MS = 1500;
  const VIDEO_ERROR_RELOAD_PREFIX = "youtube-shorts-blocker:video-error-reload-v4:";
  const HIDE_SELECTOR = [
    'a[href^="/shorts"]',
    'a[href*="youtube.com/shorts"]',
    "ytd-reel-shelf-renderer",
    "ytd-rich-shelf-renderer[is-shorts]",
    "ytd-shorts",
    "ytm-shorts-lockup-view-model",
    "ytm-shorts-lockup-view-model-v2"
  ].join(",");

  const STRUCTURAL_CONTAINERS = [
    "ytd-rich-item-renderer",
    "ytd-rich-shelf-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-guide-entry-renderer",
    "ytd-mini-guide-entry-renderer",
    "ytd-reel-item-renderer",
    "yt-lockup-view-model",
    "ytm-shorts-lockup-view-model",
    "ytm-shorts-lockup-view-model-v2",
    "yt-tab-shape"
  ];

  const PLAYER_ERROR_SELECTOR = [
    ".ytp-error-content",
    ".ytp-error-content-wrap",
    ".ytp-error-content-wrap-reason",
    "yt-player-error-message-renderer"
  ].join(",");

  const SHORTS_LABELS = new Set([
    "shorts",
    "youtube shorts"
  ]);

  const TRANSIENT_PLAYER_ERROR_PATTERNS = [
    /\ban error occurred\b/i,
    /\bplease try again later\b/i,
    /\bplayback id\b/i,
    /\bsomething went wrong\b/i
  ];

  let videoErrorReloadTimer = 0;
  let videoErrorCheckTimer = 0;
  let videoErrorStartupTimer = 0;
  let videoErrorStartupStopAt = 0;
  let videoErrorCandidateKey = "";
  let videoErrorFirstSeenAt = 0;

  function isShortsUrl(value) {
    if (!value) return false;

    try {
      const url = new URL(value, window.location.origin);
      return /^(www\.|m\.)?youtube\.com$/i.test(url.hostname) && SHORTS_PATH.test(url.pathname);
    } catch {
      return false;
    }
  }

  function getCurrentVideoKey() {
    const url = new URL(window.location.href);

    if (!WATCH_PATH.test(url.pathname)) return null;

    const videoId = url.searchParams.get("v");
    return videoId ? `${VIDEO_ERROR_RELOAD_PREFIX}${videoId}` : null;
  }

  function hideElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return;

    element.setAttribute(BLOCKED_ATTRIBUTE, "true");
    element.style.setProperty("display", "none", "important");
    element.style.setProperty("visibility", "hidden", "important");
  }

  function findContainer(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    return element.closest(STRUCTURAL_CONTAINERS.join(",")) || element;
  }

  function textLooksLikeShorts(element) {
    const title = element.getAttribute("title");
    const ariaLabel = element.getAttribute("aria-label");
    const tabTitle = element.getAttribute("tab-title");
    const text = element.textContent;

    return [title, ariaLabel, tabTitle, text]
      .filter(Boolean)
      .map((value) => value.trim().toLowerCase())
      .some((value) => SHORTS_LABELS.has(value) || value.startsWith("shorts "));
  }

  function removeShortsFrom(root = document) {
    if (!root.querySelectorAll) return;

    root.querySelectorAll(HIDE_SELECTOR).forEach((element) => {
      hideElement(findContainer(element));
    });

    root.querySelectorAll("ytd-rich-shelf-renderer, ytd-reel-shelf-renderer").forEach((shelf) => {
      if (textLooksLikeShorts(shelf)) {
        hideElement(shelf);
      }
    });

    root.querySelectorAll("a, yt-tab-shape, ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer").forEach((element) => {
      if (textLooksLikeShorts(element)) {
        hideElement(findContainer(element));
      }
    });
  }

  function leaveShortsPage() {
    if (!SHORTS_PATH.test(window.location.pathname)) return;
    window.location.replace("https://www.youtube.com/");
  }

  function getStoredReloadState(key) {
    try {
      const rawState = window.sessionStorage.getItem(key);
      if (!rawState) return { count: 0, firstAttemptAt: 0, lastAttemptAt: 0 };

      const state = JSON.parse(rawState);
      const firstAttemptAt = Number(state.firstAttemptAt) || 0;

      if (Date.now() - firstAttemptAt > VIDEO_ERROR_RELOAD_WINDOW_MS) {
        return { count: 0, firstAttemptAt: 0, lastAttemptAt: 0 };
      }

      return {
        count: Number(state.count) || 0,
        firstAttemptAt,
        lastAttemptAt: Number(state.lastAttemptAt) || 0
      };
    } catch {
      return { count: 0, firstAttemptAt: 0, lastAttemptAt: 0 };
    }
  }

  function storeReloadState(key, state) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(state));
    } catch {
      // If storage is unavailable, skip persistence and still avoid crashing YouTube.
    }
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }

    if (Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0)) {
      return true;
    }

    return Boolean(element.offsetWidth || element.offsetHeight);
  }

  function isFullscreen() {
    return Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.fullscreen ||
      document.webkitIsFullScreen
    );
  }

  function isTransientPlayerError(element) {
    if (!element || !element.isConnected) return false;
    if (!isVisible(element)) return false;

    const text = element.textContent || "";
    return TRANSIENT_PLAYER_ERROR_PATTERNS.some((pattern) => pattern.test(text));
  }

  function findTransientPlayerError() {
    return Array.from(document.querySelectorAll(PLAYER_ERROR_SELECTOR)).find(isTransientPlayerError) || null;
  }

  function queueVideoErrorCheck(delay = 250) {
    if (videoErrorCheckTimer) return;

    videoErrorCheckTimer = window.setTimeout(() => {
      videoErrorCheckTimer = 0;
      scheduleVideoErrorReload();
    }, delay);
  }

  function resetVideoErrorCandidate() {
    videoErrorCandidateKey = "";
    videoErrorFirstSeenAt = 0;
  }

  function stopVideoErrorStartupChecks() {
    if (videoErrorStartupTimer) {
      window.clearInterval(videoErrorStartupTimer);
      videoErrorStartupTimer = 0;
    }
  }

  function startVideoErrorStartupChecks() {
    stopVideoErrorStartupChecks();
    resetVideoErrorCandidate();

    if (!getCurrentVideoKey()) return;

    videoErrorStartupStopAt = Date.now() + VIDEO_ERROR_STARTUP_CHECK_MS;
    queueVideoErrorCheck(1000);

    videoErrorStartupTimer = window.setInterval(() => {
      if (!getCurrentVideoKey() || Date.now() > videoErrorStartupStopAt) {
        stopVideoErrorStartupChecks();
        resetVideoErrorCandidate();
        return;
      }

      queueVideoErrorCheck(0);
    }, VIDEO_ERROR_STARTUP_CHECK_INTERVAL_MS);
  }

  function scheduleVideoErrorReload() {
    const videoKey = getCurrentVideoKey();

    if (!videoKey) {
      resetVideoErrorCandidate();
      return;
    }

    const errorElement = findTransientPlayerError();

    if (!errorElement) {
      resetVideoErrorCandidate();
      return;
    }

    const state = getStoredReloadState(videoKey);
    const now = Date.now();

    if (state.count >= MAX_VIDEO_ERROR_RELOADS) return;
    if (isFullscreen()) return;
    if (now - state.lastAttemptAt < VIDEO_ERROR_POST_RELOAD_GRACE_MS) return;
    if (videoErrorReloadTimer) return;

    if (videoErrorCandidateKey !== videoKey) {
      videoErrorCandidateKey = videoKey;
      videoErrorFirstSeenAt = now;
      queueVideoErrorCheck(VIDEO_ERROR_STABLE_MS);
      return;
    }

    if (now - videoErrorFirstSeenAt < VIDEO_ERROR_STABLE_MS) {
      queueVideoErrorCheck(VIDEO_ERROR_STABLE_MS - (now - videoErrorFirstSeenAt));
      return;
    }

    videoErrorReloadTimer = window.setTimeout(() => {
      videoErrorReloadTimer = 0;

      if (getCurrentVideoKey() === videoKey && findTransientPlayerError()) {
        const latestState = getStoredReloadState(videoKey);
        const reloadStartedAt = Date.now();

        if (latestState.count >= MAX_VIDEO_ERROR_RELOADS) return;

        storeReloadState(videoKey, {
          count: latestState.count + 1,
          firstAttemptAt: latestState.firstAttemptAt || reloadStartedAt,
          lastAttemptAt: reloadStartedAt
        });
        resetVideoErrorCandidate();
        window.location.reload();
      }
    }, 500);
  }

  function blockShortsActivation(event) {
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;

    const target = event.target instanceof Element ? event.target : event.target && event.target.parentElement;
    const link = target && target.closest ? target.closest("a[href]") : null;

    if (!link || !isShortsUrl(link.href)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    removeShortsFrom(document);
  }

  function patchHistoryMethod(methodName) {
    const original = window.history[methodName];

    window.history[methodName] = function patchedHistoryMethod(state, title, url) {
      if (isShortsUrl(url)) {
        removeShortsFrom(document);
        return undefined;
      }

      const result = original.apply(this, arguments);
      startVideoErrorStartupChecks();
      return result;
    };
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.matches && node.matches(HIDE_SELECTOR)) {
              hideElement(findContainer(node));
            }

            removeShortsFrom(node);
          }
        });
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  document.addEventListener("pointerdown", blockShortsActivation, CAPTURE_OPTIONS);
  document.addEventListener("mousedown", blockShortsActivation, CAPTURE_OPTIONS);
  document.addEventListener("touchstart", blockShortsActivation, CAPTURE_OPTIONS);
  document.addEventListener("click", blockShortsActivation, CAPTURE_OPTIONS);
  document.addEventListener("auxclick", blockShortsActivation, CAPTURE_OPTIONS);
  document.addEventListener("keydown", blockShortsActivation, CAPTURE_OPTIONS);
  document.addEventListener("yt-navigate-start", leaveShortsPage, true);
  document.addEventListener("yt-page-data-updated", () => {
    removeShortsFrom(document);
    startVideoErrorStartupChecks();
  }, true);
  window.addEventListener("popstate", leaveShortsPage, true);
  window.addEventListener("popstate", startVideoErrorStartupChecks, true);

  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");
  leaveShortsPage();
  startObserver();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      removeShortsFrom(document);
      startVideoErrorStartupChecks();
    }, { once: true });
  } else {
    removeShortsFrom(document);
    startVideoErrorStartupChecks();
  }
})();
