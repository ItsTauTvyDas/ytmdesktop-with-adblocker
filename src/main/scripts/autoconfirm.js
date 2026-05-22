(function () {
  const tag = "[Youtube NonStop]";
  const appSelector = "ytmusic-app";
  const popupContainerSelector = "ytmusic-popup-container";
  const popupNodeName = "YTMUSIC-YOU-THERE-RENDERER";
  const idleTimeoutMillis = 5000;
  const pauseRequestTimeoutMillis = 5000;

  if (window.__YTMD_YOUTUBE_NONSTOP__) return;
  window.__YTMD_YOUTUBE_NONSTOP__ = true;

  if (window.location.hostname !== "music.youtube.com") return;

  let lastInteractionTime = Date.now();
  let pauseRequested = false;
  let pauseRequestedTimeout = null;
  let videoElement = null;

  function log(message) {
    console.log(`${tag} ${message}`);
  }

  function debug(message) {
    console.debug(`${tag} ${message}`);
  }

  function isIdle() {
    return Date.now() - lastInteractionTime >= idleTimeoutMillis;
  }

  function clearPauseRequestTimeout() {
    if (pauseRequestedTimeout !== null) {
      clearTimeout(pauseRequestedTimeout);
      pauseRequestedTimeout = null;
    }
  }

  function clearPauseRequest() {
    pauseRequested = false;
    clearPauseRequestTimeout();
  }

  function pauseVideo() {
    videoElement?.ytmdYoutubeNonStopPause?.();
    clearPauseRequest();
  }

  window.__YTMD_YOUTUBE_NONSTOP_PAUSE__ = pauseVideo;

  function processInteraction() {
    if (pauseRequested) {
      pauseVideo();
      return;
    }

    lastInteractionTime = Date.now();
  }

  function listenForUserInteraction() {
    const pointerEventName = window.PointerEvent ? "pointer" : "mouse";
    document.addEventListener(`${pointerEventName}down`, processInteraction, true);
    document.addEventListener(`${pointerEventName}up`, processInteraction, true);
    document.addEventListener("keydown", processInteraction, true);
    document.addEventListener("keyup", processInteraction, true);
  }

  function keepMediaPauseKeyHonest() {
    if (!navigator.mediaSession || navigator.mediaSession.ytmdYoutubeNonStopSetActionHandler) return;

    const originalSetActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.ytmdYoutubeNonStopSetActionHandler = originalSetActionHandler;

    try {
      originalSetActionHandler("pause", () => {
        pauseVideo();
      });
    } catch {
      return;
    }

    navigator.mediaSession.setActionHandler = (action, handler) => {
      if (action === "pause") {
        debug("Blocked YouTube Music from replacing the pause media key handler");
        return;
      }

      originalSetActionHandler(action, handler);
    };
  }

  function overrideVideoPause() {
    const currentVideoElement = document.querySelector("video");
    if (!currentVideoElement || currentVideoElement.ytmdYoutubeNonStopPause) return;

    videoElement = currentVideoElement;
    videoElement.ytmdYoutubeNonStopPause = videoElement.pause.bind(videoElement);

    videoElement.pause = () => {
      if (!isIdle()) {
        pauseVideo();
        return;
      }

      pauseRequested = true;
      clearPauseRequestTimeout();
      pauseRequestedTimeout = setTimeout(clearPauseRequest, pauseRequestTimeoutMillis);
    };

    keepMediaPauseKeyHonest();
  }

  function closeStillWatchingPopup() {
    const popupContainer = document.querySelector(popupContainerSelector);
    popupContainer?.click();
    pauseVideo();
    videoElement?.play?.();
  }

  function listenForStillWatchingPopup() {
    document.addEventListener("yt-popup-opened", event => {
      if (!isIdle() || event.detail?.nodeName !== popupNodeName) return;

      closeStillWatchingPopup();
    });
  }

  function observeApp() {
    const app = document.querySelector(appSelector);
    if (!app) return false;

    overrideVideoPause();

    const appObserver = new MutationObserver(overrideVideoPause);
    appObserver.observe(app, { childList: true, subtree: true });
    return true;
  }

  function start() {
    listenForUserInteraction();
    listenForStillWatchingPopup();

    if (observeApp()) {
      log("Monitoring YouTube Music for the still-watching confirmation");
      return;
    }

    const startupObserver = new MutationObserver(() => {
      if (!observeApp()) return;

      startupObserver.disconnect();
      log("Monitoring YouTube Music for the still-watching confirmation");
    });

    startupObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  start();
})();
