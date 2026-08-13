import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { VisionConfig } from "./config.js";
import { VisionError } from "./errors.js";
import { fetchRemoteBuffer } from "./network.js";

export interface LoadedImage {
  dataUrl: string;
  mimeType: string;
  bytes: number;
  label: string;
}

const SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

function mimeFromMagic(buffer: Buffer): string | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString("ascii", 0, 6))) {
    return "image/gif";
  }
  if (buffer.length >= 2 && buffer.toString("ascii", 0, 2) === "BM") {
    return "image/bmp";
  }
  return undefined;
}

function expandLocalPath(source: string): string {
  const withoutAt = source.startsWith("@") ? source.slice(1) : source;
  if (withoutAt === "~") return homedir();
  if (withoutAt.startsWith("~/")) {
    return path.join(homedir(), withoutAt.slice(2));
  }
  return path.resolve(withoutAt);
}

function toLoadedImage(buffer: Buffer, label: string, declaredMime?: string): LoadedImage {
  const detectedMime = mimeFromMagic(buffer);
  const normalizedDeclared = declaredMime?.toLowerCase();
  const mimeType = detectedMime ??
    (normalizedDeclared && SUPPORTED_MIME_TYPES.has(normalizedDeclared)
      ? normalizedDeclared
      : undefined);
  if (!mimeType) {
    throw new VisionError(
      "UNSUPPORTED_IMAGE",
      "Unsupported or invalid image. Supported formats: JPEG, PNG, WebP, GIF, BMP",
    );
  }
  return {
    dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
    mimeType,
    bytes: buffer.length,
    label,
  };
}

function parseDataUri(source: string, maxBytes: number): LoadedImage {
  const match = source.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match?.[1] || !match[2]) {
    throw new VisionError("INVALID_SOURCE", "Invalid base64 image data URI");
  }
  const compact = match[2].replace(/\s/g, "");
  if (compact.length % 4 !== 0) {
    throw new VisionError("INVALID_SOURCE", "Invalid base64 image data URI");
  }
  const buffer = Buffer.from(compact, "base64");
  if (buffer.length > maxBytes) {
    throw new VisionError("SOURCE_TOO_LARGE", "Image data URI exceeds the configured limit");
  }
  return toLoadedImage(buffer, "data-uri", match[1]);
}

export async function loadImage(
  source: string,
  config: VisionConfig,
): Promise<LoadedImage> {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new VisionError("INVALID_SOURCE", "Image source cannot be empty");
  }
  if (trimmed.startsWith("data:")) {
    return parseDataUri(trimmed, config.maxImageBytes);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const remote = await fetchRemoteBuffer({
      url: trimmed,
      maxBytes: config.maxImageBytes,
      timeoutMs: config.timeoutMs,
      allowPrivateUrls: config.allowPrivateUrls,
    });
    return toLoadedImage(remote.buffer, trimmed, remote.contentType);
  }

  const filePath = expandLocalPath(trimmed);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    throw new VisionError("FILE_NOT_FOUND", `Image file not found: ${filePath}`, {
      cause: error,
    });
  }
  if (!fileStat.isFile()) {
    throw new VisionError("INVALID_SOURCE", `Not a file: ${filePath}`);
  }
  if (fileStat.size > config.maxImageBytes) {
    throw new VisionError(
      "SOURCE_TOO_LARGE",
      `Image is ${(fileStat.size / 1024 / 1024).toFixed(1)} MB; limit is ${(config.maxImageBytes / 1024 / 1024).toFixed(1)} MB`,
    );
  }
  return toLoadedImage(await readFile(filePath), path.basename(filePath));
}
