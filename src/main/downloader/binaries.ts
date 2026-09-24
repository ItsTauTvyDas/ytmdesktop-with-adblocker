import { app, net } from "electron";
import { spawn } from "child_process";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import log from "electron-log";

const inflateRaw = promisify(zlib.inflateRaw);

export interface Ctx {
  signal: AbortSignal;
  onStatus: (text: string, percent: number | null) => void;
}

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const exe = (name: string) => (isWin ? `${name}.exe` : name);
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false
  );

let cachedDir: string | null = null;
export async function getBinDir(): Promise<string> {
  if (cachedDir) return cachedDir;
  const candidates: string[] = [];
  if (!isMac)
    // Prevent writing into macos app
    candidates.push(path.join(app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(), "ytdlp-bin"));
  candidates.push(path.join(app.getPath("userData"), "ytdlp-bin"));
  for (const dir of candidates) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const probe = path.join(dir, ".write-test");
      await fs.writeFile(probe, "");
      await fs.rm(probe, { force: true });
      cachedDir = dir;
      log.info("ytdlp-bin folder:", dir);
      return dir;
    } catch {
      /* not writable, try the next candidate */
    }
  }
  throw new Error("No writable folder available for ytdlp-bin");
}
async function downloadToFile(url: string, dest: string, label: string, ctx: Ctx): Promise<void> {
  const res = await net.fetch(url, { signal: ctx.signal });
  if (!res.ok || !res.body) throw new Error(`${label}: download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const out = createWriteStream(dest);
  const finished = new Promise<void>((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
  });

  let received = 0;
  let lastEmit = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(value)) await new Promise<void>(r => out.once("drain", r));
      const now = Date.now();
      if (now - lastEmit > 100) {
        lastEmit = now;
        ctx.onStatus(`Downloading ${label}…`, total ? (received / total) * 100 : null);
      }
    }
  } catch (err) {
    out.destroy();
    await fs.rm(dest, {
      force: true
    });
    throw err;
  }
  out.end();
  await finished;
}

async function extractZip(zipPath: string, wanted: Record<string, string>): Promise<void> {
  const buf = await fs.readFile(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const found = new Set<string>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    const key = Object.keys(wanted).find(k => name === k || name.endsWith("/" + k));
    if (!key) continue;
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported zip compression method ${method}`);
    await fs.writeFile(wanted[key], method === 0 ? data : await inflateRaw(data));
    found.add(key);
  }

  for (const key of Object.keys(wanted)) {
    if (!found.has(key)) throw new Error(`"${key}" not found in ${path.basename(zipPath)}`);
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      windowsHide: true,
      stdio: "ignore"
    });
    p.on("error", reject);
    p.on("close", code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

export async function ensureYtDlp(ctx: Ctx): Promise<string> {
  const dir = await getBinDir();
  const target = path.join(dir, exe("yt-dlp"));
  if (await exists(target)) return target;
  const asset = isWin ? "yt-dlp.exe" : isMac ? "yt-dlp_macos" : process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
  const tmp = target + ".part";
  await downloadToFile(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, tmp, "yt-dlp", ctx);
  if (!isWin) await fs.chmod(tmp, 0o755);
  await fs.rename(tmp, target);
  return target;
}

export async function ensureDeno(ctx: Ctx): Promise<string> {
  const dir = await getBinDir();
  const target = path.join(dir, exe("deno"));
  if (await exists(target)) return target;
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const triple = isWin ? "x86_64-pc-windows-msvc" : isMac ? `${arch}-apple-darwin` : `${arch}-unknown-linux-gnu`;
  const zip = path.join(dir, "deno.zip.part");
  await downloadToFile(`https://github.com/denoland/deno/releases/latest/download/deno-${triple}.zip`, zip, "Deno", ctx);
  ctx.onStatus("Extracting Deno…", null);
  await extractZip(zip, { [exe("deno")]: target });
  await fs.rm(zip, { force: true });
  if (!isWin) await fs.chmod(target, 0o755);
  return target;
}

async function findInPath(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (isMac) dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const d of dirs) {
    if (await exists(path.join(d, exe(name)))) return d;
  }
  return null;
}

export async function ensureFfmpeg(ctx: Ctx): Promise<string> {
  const dir = await getBinDir();
  if ((await exists(path.join(dir, exe("ffmpeg")))) && (await exists(path.join(dir, exe("ffprobe"))))) return dir;
  const onPath = await findInPath("ffmpeg");
  if (onPath && (await exists(path.join(onPath, exe("ffprobe"))))) return onPath;
  if (isMac) throw new Error("ffmpeg not found. Install it with Homebrew: brew install ffmpeg");
  const base = "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/";
  if (isWin) {
    const zip = path.join(dir, "ffmpeg.zip.part");
    await downloadToFile(base + "ffmpeg-master-latest-win64-gpl.zip", zip, "ffmpeg", ctx);
    ctx.onStatus("Extracting ffmpeg…", null);
    await extractZip(zip, {
      "bin/ffmpeg.exe": path.join(dir, "ffmpeg.exe"),
      "bin/ffprobe.exe": path.join(dir, "ffprobe.exe")
    });
    await fs.rm(zip, { force: true });
  } else {
    const archive = path.join(dir, "ffmpeg.tar.xz.part");
    const name = process.arch === "arm64" ? "linuxarm64" : "linux64";
    await downloadToFile(`${base}ffmpeg-master-latest-${name}-gpl.tar.xz`, archive, "ffmpeg", ctx);
    ctx.onStatus("Extracting ffmpeg…", null);
    await run("tar", ["-xJf", archive, "-C", dir, "--strip-components=2", "--wildcards", "*/bin/ffmpeg", "*/bin/ffprobe"]);
    await fs.rm(archive, { force: true });
    await fs.chmod(path.join(dir, "ffmpeg"), 0o755);
    await fs.chmod(path.join(dir, "ffprobe"), 0o755);
  }
  return dir;
}
