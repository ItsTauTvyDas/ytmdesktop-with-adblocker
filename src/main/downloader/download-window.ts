import { app, BrowserWindow, shell } from "electron";
import { ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";
import log from "electron-log";

import { DOWNLOAD_PAGE_HTML } from "./download-page";
import { Ctx, ensureDeno, ensureFfmpeg, ensureYtDlp } from "./binaries";
import { cleanupPartials, fetchInfo, killTree, runDownload, VideoInfo, waitForExit } from "./ytdlp";

export const getDownloadDir = () => path.join(app.getPath("downloads"), "YTM Downloads");

const MP3_QUALITIES = ["0", "192K", "128K"];
const CLEAN_ON_FAILURE = false;

type Choice = { kind: "mp4"; height: number } | { kind: "mp3"; audioQuality: string };

let active = false;
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});

async function findDownloadedFile(dir: string, videoId: string): Promise<string | null> {
  try {
    const marker = `[${videoId}]`;
    const names = (await fs.readdir(dir)).filter(
      n => n.includes(marker) && !/\.(part(-Frag\d+)?|ytdl)$/.test(n) && !/\]\.(f[\w-]+|temp)\.[A-Za-z0-9]+$/.test(n)
    );
    const withTime = await Promise.all(names.map(async n => ({ n, t: (await fs.stat(path.join(dir, n))).mtimeMs })));
    withTime.sort((a, b) => b.t - a.t);
    return withTime[0] ? path.join(dir, withTime[0].n) : null;
  } catch {
    return null;
  }
}

export async function startDownloadFlow(parent: BrowserWindow, videoId: string): Promise<void> {
  if (active || !/^[\w-]{11}$/.test(videoId)) return;
  active = true;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const outDir = getDownloadDir();
  let busy = true;
  let cancelled = false;
  let downloading = false;
  let completed = false;
  let current: ChildProcess | null = null;
  let info: VideoInfo | null = null;
  let finalPath: string | null = null;
  let pendingChoice: ((c: Choice | null) => void) | null = null;
  let cleanup: Promise<void> | null = null;
  const ac = new AbortController();
  const win = new BrowserWindow({
    width: 460,
    height: 420,
    parent,
    modal: process.platform !== "darwin",
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    show: false,
    backgroundColor: "#121212",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#121212", symbolColor: "#BBBBBB", height: 36 },
    webPreferences: { sandbox: true, contextIsolation: true, devTools: false }
  });
  const alive = () => !cancelled && !win.isDestroyed();
  const send = async (state: object) => {
    if (win.isDestroyed()) return;
    try {
      await win.webContents.executeJavaScript(`window.setState(${JSON.stringify(state)})`);
    } catch {
      /* window is closing */
    }
  };
  let lastSend = 0;
  const sendThrottled = (state: object) => {
    const now = Date.now();
    if (now - lastSend < 100) return;
    lastSend = now;
    void send(state);
  };
  const killAndClean = (): Promise<void> => {
    cleanup ??= (async () => {
      const child = current;
      killTree(child);
      await waitForExit(child);
      if (downloading && !completed) await cleanupPartials(outDir, videoId);
    })();
    return cleanup;
  };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    ac.abort();
    void killAndClean();
    pendingChoice?.(null);
    busy = false;
    if (!win.isDestroyed()) win.close();
  };
  const openDownloadLocation = async () => {
    let target = finalPath ? path.normalize(finalPath) : null;
    const exists = target
      ? await fs.access(target).then(
          () => true,
          () => false
        )
      : false;
    if (!exists) target = await findDownloadedFile(outDir, videoId);
    log.info("Open folder requested", { finalPath, target, outDir });
    if (target) {
      shell.showItemInFolder(target);
      return;
    }
    const error = await shell.openPath(outDir);
    if (error) log.warn("shell.openPath failed:", error);
  };
  const onMessage = (raw: unknown) => {
    const m = raw as { type?: string; kind?: string; quality?: string };
    switch (m?.type) {
      case "cancel":
        cancel();
        break;
      case "close":
        busy = false;
        win.close();
        break;
      case "open-folder":
        void openDownloadLocation();
        break;
      case "start": {
        if (!pendingChoice || !info) return;
        let choice: Choice | null = null;
        if (m.kind === "mp4") {
          const height = Number(m.quality);
          if (info.heights.includes(height)) choice = { kind: "mp4", height };
        } else if (m.kind === "mp3" && typeof m.quality === "string" && MP3_QUALITIES.includes(m.quality)) {
          choice = { kind: "mp3", audioQuality: m.quality };
        }
        if (choice) {
          const resolve = pendingChoice;
          pendingChoice = null;
          resolve(choice);
        }
        break;
      }
    }
  };
  win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    if (openUrl.startsWith("ytmd-dl:")) {
      try {
        onMessage(JSON.parse(decodeURIComponent(openUrl.slice("ytmd-dl:".length))));
      } catch (err) {
        log.warn("Bad message from download window", err);
      }
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", e => e.preventDefault());
  win.on("close", e => {
    if (busy && !quitting) {
      e.preventDefault();
      setImmediate(cancel);
    }
  });
  win.on("closed", () => {
    ac.abort();
    pendingChoice?.(null);
    void killAndClean().finally(() => {
      active = false;
    });
  });
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(DOWNLOAD_PAGE_HTML));
  } catch (err) {
    log.error("Failed to load download window", err);
    busy = false;
    win.destroy();
    return;
  }
  win.show();
  const ctx: Ctx = {
    signal: ac.signal,
    onStatus: (text, percent) =>
      sendThrottled({
        view: "loading",
        text,
        percent
      })
  };
  try {
    await send({ view: "loading", text: "Preparing yt-dlp…", percent: null });
    const bin = await ensureYtDlp(ctx);
    if (!alive()) return;
    await send({ view: "loading", text: "Preparing JavaScript runtime…", percent: null });
    const deno = await ensureDeno(ctx).catch((err): string | null => {
      log.warn("Deno unavailable, continuing without it:", err);
      return null;
    });
    if (!alive()) return;
    await send({
      view: "loading",
      text: "Fetching video info…",
      percent: null
    });
    info = await fetchInfo(bin, url, deno, c => (current = c));
    if (!alive()) return;
    await send({ view: "options", title: info.title, heights: info.heights });
    const choice = await new Promise<Choice | null>(resolve => (pendingChoice = resolve));
    if (!choice || !alive()) return;
    await send({ view: "loading", text: "Preparing ffmpeg…", percent: null });
    const ffmpegDir = await ensureFfmpeg(ctx);
    if (!alive()) return;
    await fs.mkdir(outDir, { recursive: true });
    await send({ view: "progress", stage: "video", percent: null, speed: "", eta: "" });
    downloading = true;
    finalPath = await runDownload(
      {
        bin,
        denoPath: deno,
        ffmpegDir,
        url,
        outDir,
        kind: choice.kind,
        height: choice.kind === "mp4" ? choice.height : undefined,
        audioQuality: choice.kind === "mp3" ? choice.audioQuality : undefined
      },
      c => (current = c),
      p => sendThrottled({ view: "progress", ...p })
    );
    if (!alive()) return;
    completed = true;
    busy = false;
    await send({
      view: "result",
      ok: true,
      text: "Download complete",
      canOpen: true
    });
  } catch (err) {
    if (cancelled) return;
    log.error("Download failed", err);
    busy = false;
    if (CLEAN_ON_FAILURE && downloading) await cleanupPartials(outDir, videoId);
    await send({ view: "result", ok: false, text: err instanceof Error ? err.message : String(err), canOpen: false });
  }
}
