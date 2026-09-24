import { ChildProcess, spawn } from "child_process";
import log from "electron-log";
import fs from "fs/promises";
import path from "path";

const DEBUG = true;

export interface VideoInfo {
  title: string;
  heights: number[];
}

export interface Progress {
  percent: number | null;
  speed: string;
  eta: string;
  stage: "video" | "audio" | "processing";
}

export interface DownloadParams {
  bin: string;
  denoPath: string | null;
  ffmpegDir: string;
  url: string;
  outDir: string;
  kind: "mp4" | "mp3";
  height?: number;
  audioQuality?: string;
}

function spawnYtDlp(bin: string, args: string[]): ChildProcess {
  return spawn(bin, args, {
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
  });
}

const jsRuntimeArgs = (deno: string | null) => (deno ? ["--js-runtimes", `deno:${deno}`] : []);

export function killTree(child: ChildProcess | null): void {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** Resolves when the process has exited (or after a timeout), so its files are no longer locked. */
export function waitForExit(child: ChildProcess | null, timeoutMs = 3000): Promise<void> {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function cleanupPartials(dir: string, videoId: string): Promise<void> {
  const patterns = [
    new RegExp(`\\[${videoId}\\].*\\.(part(-Frag\\d+)?|ytdl)$`), // *.part, *.part-FragN, *.ytdl
    new RegExp(`\\[${videoId}\\]\\.f[\\w-]+\\.[A-Za-z0-9]+$`), // per-format intermediates (.f137.mp4)
    new RegExp(`\\[${videoId}\\]\\.temp\\.[A-Za-z0-9]+$`) // merge/convert temp files
  ];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!patterns.some(re => re.test(name))) continue;
    try {
      await fs.rm(path.join(dir, name), { force: true, maxRetries: 5, retryDelay: 200 });
      log.info("Removed partial file", name);
    } catch (err) {
      log.warn("Could not remove partial file", name, err);
    }
  }
}

function errorFrom(stderr: string, code: number | null): Error {
  const lines = stderr
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  const msg = [...lines].reverse().find(l => l.startsWith("ERROR")) ?? lines[lines.length - 1] ?? `yt-dlp exited with code ${code}`;
  return new Error(msg.replace(/^ERROR:\s*/, "").slice(0, 300));
}

export function fetchInfo(bin: string, url: string, deno: string | null, onSpawn: (c: ChildProcess) => void): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const child = spawnYtDlp(bin, ["-J", "--no-playlist", "--no-warnings", ...jsRuntimeArgs(deno), url]);
    onSpawn(child);
    let out = "";
    let err = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", d => (out += d));
    child.stderr!.on("data", d => (err += d));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(errorFrom(err, code));
      try {
        const j = JSON.parse(out) as { title?: string; formats?: { vcodec?: string; height?: number }[] };
        const heights = [
          ...new Set((j.formats ?? []).filter(f => f.vcodec && f.vcodec !== "none" && typeof f.height === "number").map(f => f.height as number))
        ].sort((a, b) => b - a);
        resolve({ title: String(j.title ?? "Unknown title"), heights });
      } catch (e) {
        reject(e);
      }
    });
  });
}

const cleanStat = (s: string) => (!s || s === "NA" || s === "N/A" || s.startsWith("Unknown") ? "" : s);

export function runDownload(p: DownloadParams, onSpawn: (c: ChildProcess) => void, onProgress: (pr: Progress) => void): Promise<string | null> {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--progress",
    "--color",
    "never",
    "--ffmpeg-location",
    p.ffmpegDir,
    "-P",
    p.outDir,
    "-o",
    "%(title).150s [%(id)s].%(ext)s",
    "--embed-metadata",
    "--progress-template",
    "download:YTMD_PROG:%(progress.status)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.vcodec)s",
    "--print",
    "after_move:YTMD_FILE:%(filepath)s",
    ...jsRuntimeArgs(p.denoPath)
  ];
  if (p.kind === "mp4") {
    const h = p.height;
    args.push("-f", `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]`, "--merge-output-format", "mp4");
  } else {
    args.push("-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", p.audioQuality ?? "0");
  }
  args.push(p.url);
  return new Promise((resolve, reject) => {
    const child = spawnYtDlp(p.bin, args);
    onSpawn(child);
    let finalPath: string | null = null;
    let err = "";
    let buf = "";
    const handleLine = (line: string) => {
      if (DEBUG) log.debug("[yt-dlp]", line);
      if (line.startsWith("YTMD_PROG:")) {
        const [status, pct, speed, eta, vcodec] = line
          .slice("YTMD_PROG:".length)
          .split("|")
          .map(s => s.trim());
        if (status === "finished") {
          onProgress({ percent: 100, speed: "", eta: "", stage: "processing" });
        } else {
          const n = parseFloat(pct);
          onProgress({
            percent: Number.isFinite(n) ? n : null,
            speed: cleanStat(speed),
            eta: cleanStat(eta),
            stage: vcodec && vcodec !== "none" && vcodec !== "NA" ? "video" : "audio"
          });
        }
      } else if (line.startsWith("YTMD_FILE:")) {
        finalPath = line.slice("YTMD_FILE:".length).trim();
      }
    };
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      buf += d;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop() ?? "";
      lines.forEach(handleLine);
    });
    child.stderr!.on("data", (d: string) => (err += d));
    child.on("error", reject);
    child.on("close", code => {
      if (buf) handleLine(buf);
      if (code === 0) resolve(finalPath);
      else reject(errorFrom(err, code));
    });
  });
}
