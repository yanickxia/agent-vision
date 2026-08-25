import { spawn } from "node:child_process";
import { access, chmod, readFile, readdir, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import type { VisionConfig } from "./config.js";
import { VisionError } from "./errors.js";
import { downloadRemoteFile } from "./network.js";
import type { VisionInputImage } from "./provider.js";

export interface VideoFrame extends VisionInputImage {
  timestampSeconds: number;
}

let ffmpegReady: Promise<string> | undefined;

async function usableFile(filePath: string): Promise<boolean> {
  try {
    await access(
      filePath,
      process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

async function systemFfmpeg(): Promise<string | undefined> {
  const executableName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executableName);
    if (await usableFile(candidate)) return candidate;
  }
  return undefined;
}

async function bundledFfmpeg(): Promise<string | undefined> {
  try {
    const imported = await import("@ffmpeg-installer/ffmpeg");
    const installer = imported.default as { path?: string } | undefined;
    return installer?.path;
  } catch {
    return undefined;
  }
}

export function ensureFfmpeg(configuredPath?: string): Promise<string> {
  ffmpegReady ??= (async () => {
    const configured = configuredPath?.trim() || process.env.AGENT_VISION_FFMPEG_PATH?.trim();
    if (configured) {
      const resolved = path.resolve(configured);
      if (!(await usableFile(resolved))) {
        throw new VisionError(
          "FFMPEG_NOT_AVAILABLE",
          `AGENT_VISION_FFMPEG_PATH is not executable: ${resolved}`,
        );
      }
      return resolved;
    }
    const ffmpegPath = (await systemFfmpeg()) ?? (await bundledFfmpeg());
    if (!ffmpegPath) {
      throw new VisionError(
        "FFMPEG_NOT_AVAILABLE",
        "The bundled ffmpeg binary is unavailable on this platform",
      );
    }
    if (process.platform !== "win32") {
      try {
        await chmod(ffmpegPath, 0o755);
      } catch (error) {
        throw new VisionError(
          "FFMPEG_NOT_AVAILABLE",
          "The bundled ffmpeg binary could not be made executable",
          { cause: error },
        );
      }
    }
    return ffmpegPath;
  })();
  return ffmpegReady;
}

function expandLocalPath(source: string): string {
  if (source === "~") return homedir();
  if (source.startsWith("~/")) return path.join(homedir(), source.slice(2));
  return path.resolve(source.startsWith("@") ? source.slice(1) : source);
}

async function runFfmpeg(
  args: string[],
  allowFailure = false,
  timeoutMs = 120_000,
  configuredPath?: string,
): Promise<string> {
  const command = await ensureFfmpeg(configuredPath);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 1_000_000) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new VisionError("FFMPEG_ERROR", "Could not start ffmpeg", { cause: error }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new VisionError("FFMPEG_TIMEOUT", `ffmpeg timed out after ${timeoutMs} ms`));
        return;
      }
      if (code === 0 || allowFailure) resolve(stderr);
      else reject(new VisionError("FFMPEG_ERROR", stderr.trim().slice(-1000) || `ffmpeg exited with code ${code}`));
    });
  });
}

async function videoDuration(
  filePath: string,
  timeoutMs: number,
  configuredPath?: string,
): Promise<number> {
  const output = await runFfmpeg(
    ["-hide_banner", "-i", filePath],
    true,
    timeoutMs,
    configuredPath,
  );
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new VisionError("UNSUPPORTED_VIDEO", "Could not determine video duration");
  }
  const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new VisionError("UNSUPPORTED_VIDEO", "Video duration is invalid");
  }
  return duration;
}

async function prepareInput(
  source: string,
  workDir: string,
  config: VisionConfig,
): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const destination = path.join(workDir, "input-video");
    await downloadRemoteFile({
      url: source,
      destination,
      maxBytes: config.maxVideoBytes,
      timeoutMs: config.timeoutMs,
      allowPrivateUrls: config.allowPrivateUrls,
    });
    return destination;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    throw new VisionError("INVALID_SOURCE", "Video source must be a local path or HTTP(S) URL");
  }
  const filePath = expandLocalPath(source);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    throw new VisionError("FILE_NOT_FOUND", `Video file not found: ${filePath}`, {
      cause: error,
    });
  }
  if (!fileStat.isFile()) {
    throw new VisionError("INVALID_SOURCE", `Not a file: ${filePath}`);
  }
  if (fileStat.size > config.maxVideoBytes) {
    throw new VisionError(
      "SOURCE_TOO_LARGE",
      `Video is ${(fileStat.size / 1024 / 1024).toFixed(1)} MB; limit is ${(config.maxVideoBytes / 1024 / 1024).toFixed(1)} MB`,
    );
  }
  return filePath;
}

export async function extractVideoFrames(options: {
  source: string;
  maxFrames: number;
  config: VisionConfig;
  tempRoot?: string;
}): Promise<VideoFrame[]> {
  if (!Number.isInteger(options.maxFrames) || options.maxFrames < 1 || options.maxFrames > 16) {
    throw new VisionError("INVALID_ARGUMENT", "maxFrames must be an integer from 1 to 16");
  }
  const prefix = path.join(options.tempRoot ?? tmpdir(), "agent-vision-");
  const workDir = await mkdtemp(prefix);
  try {
    const inputPath = await prepareInput(options.source.trim(), workDir, options.config);
    const duration = await videoDuration(
      inputPath,
      options.config.timeoutMs,
      options.config.ffmpegPath,
    );
    const timestamps = Array.from(
      { length: options.maxFrames },
      (_, index) => ((index + 0.5) * duration) / options.maxFrames,
    );
    for (const [index, timestamp] of timestamps.entries()) {
      const outputPath = path.join(workDir, `frame-${String(index + 1).padStart(3, "0")}.jpg`);
      await runFfmpeg(
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          timestamp.toFixed(3),
          "-i",
          inputPath,
          "-frames:v",
          "1",
          "-vf",
          "scale=1600:1600:force_original_aspect_ratio=decrease",
          "-q:v",
          "3",
          "-y",
          outputPath,
        ],
        false,
        options.config.timeoutMs,
        options.config.ffmpegPath,
      );
    }
    const frameNames = (await readdir(workDir))
      .filter((name) => /^frame-\d+\.jpg$/.test(name))
      .sort();
    if (frameNames.length === 0) {
      throw new VisionError("FFMPEG_ERROR", "ffmpeg did not produce any video frames");
    }
    return Promise.all(
      frameNames.map(async (name, index) => {
        const timestamp = timestamps[index] ?? 0;
        const buffer = await readFile(path.join(workDir, name));
        return {
          dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
          label: `frame at ${timestamp.toFixed(2)} seconds`,
          timestampSeconds: timestamp,
        };
      }),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
