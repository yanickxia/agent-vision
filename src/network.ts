import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { open } from "node:fs/promises";
import { VisionError } from "./errors.js";

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const first = parts[0];
  const second = parts[1];
  if (parts.length !== 4 || first === undefined || second === undefined) {
    return false;
  }
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized) || normalized.startsWith("ff")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped?.[1] ? isPrivateIpv4(mapped[1]) : false;
}

export async function validateRemoteUrl(
  rawUrl: string,
  allowPrivateUrls: boolean,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new VisionError("INVALID_SOURCE", `Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new VisionError("INVALID_SOURCE", "Only HTTP(S) URLs are supported");
  }
  if (allowPrivateUrls) return url;
  if (url.hostname.toLowerCase() === "localhost") {
    throw new VisionError("PRIVATE_URL_BLOCKED", "Private source URLs are blocked");
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch (error) {
    throw new VisionError(
      "DOWNLOAD_ERROR",
      `Cannot resolve ${url.hostname}`,
      { cause: error },
    );
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new VisionError("PRIVATE_URL_BLOCKED", "Private source URLs are blocked");
  }
  return url;
}

async function fetchFollowingRedirects(
  rawUrl: string,
  allowPrivateUrls: boolean,
  signal: AbortSignal,
): Promise<Response> {
  let current = rawUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const url = await validateRemoteUrl(current, allowPrivateUrls);
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual", signal });
    } catch (error) {
      if (signal.aborted) {
        throw new VisionError("DOWNLOAD_TIMEOUT", `Timed out downloading ${rawUrl}`);
      }
      throw new VisionError("DOWNLOAD_ERROR", `Failed to download ${rawUrl}`, {
        cause: error,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new VisionError("DOWNLOAD_ERROR", "Redirect has no Location header");
      }
      await response.body?.cancel();
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      throw new VisionError(
        "DOWNLOAD_ERROR",
        `Source returned HTTP ${response.status}`,
      );
    }
    return response;
  }
  throw new VisionError("DOWNLOAD_ERROR", "Too many redirects (maximum 3)");
}

function assertContentLength(response: Response, maxBytes: number): void {
  const raw = response.headers.get("content-length");
  if (!raw) return;
  const length = Number(raw);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new VisionError(
      "SOURCE_TOO_LARGE",
      `Remote source is ${(length / 1024 / 1024).toFixed(1)} MB; limit is ${(maxBytes / 1024 / 1024).toFixed(1)} MB`,
    );
  }
}

export async function fetchRemoteBuffer(options: {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  allowPrivateUrls: boolean;
}): Promise<{ buffer: Buffer; contentType?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchFollowingRedirects(
      options.url,
      options.allowPrivateUrls,
      controller.signal,
    );
    assertContentLength(response, options.maxBytes);
    if (!response.body) {
      throw new VisionError("DOWNLOAD_ERROR", "Remote source has an empty body");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel();
        throw new VisionError(
          "SOURCE_TOO_LARGE",
          `Remote source exceeds ${(options.maxBytes / 1024 / 1024).toFixed(1)} MB`,
        );
      }
      chunks.push(Buffer.from(value));
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    return {
      buffer: Buffer.concat(chunks, total),
      ...(contentType ? { contentType } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadRemoteFile(options: {
  url: string;
  destination: string;
  maxBytes: number;
  timeoutMs: number;
  allowPrivateUrls: boolean;
}): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const response = await fetchFollowingRedirects(
      options.url,
      options.allowPrivateUrls,
      controller.signal,
    );
    assertContentLength(response, options.maxBytes);
    if (!response.body) {
      throw new VisionError("DOWNLOAD_ERROR", "Remote source has an empty body");
    }
    file = await open(options.destination, "w");
    const reader = response.body.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel();
        throw new VisionError(
          "SOURCE_TOO_LARGE",
          `Remote source exceeds ${(options.maxBytes / 1024 / 1024).toFixed(1)} MB`,
        );
      }
      await file.write(value);
    }
    return total;
  } finally {
    clearTimeout(timer);
    await file?.close();
  }
}
