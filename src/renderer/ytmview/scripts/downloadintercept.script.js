(function() {
  if (window.__YTMD_DOWNLOAD_HOOKED__) return;
  window.__YTMD_DOWNLOAD_HOOKED__ = true;

  const DEBUG = true;
  const ORIGIN = "https://music.youtube.com/";
  const ID_RE = /^[\w-]{11}$/;
  const ITEM_TAG = "ytmusic-menu-service-item-download-renderer";

  function idsFromData(item) {
    try {
      const json = JSON.stringify(item.data ?? null) ?? "";
      return {
        json,
        videoId: json.match(/"videoId":"([\w-]{11})"/)?.[1] ?? null,
        playlistId: json.match(/"playlistId":"([\w-]+)"/)?.[1] ?? null
      };
    } catch {
      return { json: "", videoId: null, playlistId: null };
    }
  }

  function videoIdFromPopupLinks(item) {
    const popup = item.closest("ytmusic-menu-popup-renderer");
    for (const a of popup?.querySelectorAll('a[href*="watch?v="]') ?? []) {
      const v = new URL(a.getAttribute("href"), ORIGIN).searchParams.get("v");
      if (v && ID_RE.test(v)) return v;
    }
    return null;
  }

  function closeMenu(item) {
    item.closest("ytmusic-menu-popup-renderer")?.querySelector("#hidden-close-button")?.click();
    document.querySelectorAll("ytmusic-popup-container tp-yt-iron-dropdown").forEach(d => {
      if (d.opened) d.close();
    });
  }

  window.addEventListener(
    "click",
    e => {
      const item = e.composedPath().find(n => n.localName === ITEM_TAG);
      if (!item) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      const data = idsFromData(item);
      const videoId = data.videoId ?? videoIdFromPopupLinks(item);

      if (DEBUG) {
        console.debug("[ytmd] download clicked", { videoId, playlistId: data.playlistId, data: data.json.slice(0, 2000) });
      }

      window.ytmd.sendDownloadRequest({ videoId, playlistId: data.playlistId });
      closeMenu(item);
    },
    true
  );
})
