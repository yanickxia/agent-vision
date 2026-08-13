import { VisionError } from "./errors.js";

export interface VisionConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  headers: Record<string, string>;
  maxImageBytes: number;
  maxVideoBytes: number;
  allowPrivateUrls: boolean;
}

type Environment = Record<string, string | undefined>;

function firstNonEmpty(env: Environment, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function positiveInteger(
  env: Environment,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VisionError("CONFIG_ERROR", `${name} must be a positive integer`);
  }
  return value;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("expected a JSON object");
    }
    const headers: Record<string, string> = {};
    for (const [key, headerValue] of Object.entries(value)) {
      if (typeof headerValue !== "string") {
        throw new Error(`header ${key} must be a string`);
      }
      headers[key] = headerValue;
    }
    return headers;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new VisionError(
      "CONFIG_ERROR",
      `AGENT_VISION_HEADERS must be a JSON object of string values: ${detail}`,
    );
  }
}

export function loadConfig(env: Environment = process.env): VisionConfig {
  const apiKey = firstNonEmpty(env, [
    "AGENT_VISION_API_KEY",
    "VISION_API_KEY",
    "OPENAI_API_KEY",
  ]);
  const baseUrl =
    firstNonEmpty(env, [
      "AGENT_VISION_BASE_URL",
      "VISION_BASE_URL",
      "OPENAI_BASE_URL",
    ]) ?? "https://api.openai.com/v1";
  const model =
    firstNonEmpty(env, [
      "AGENT_VISION_MODEL",
      "VISION_MODEL",
      "OPENAI_MODEL",
    ]) ?? "";

  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    model,
    maxTokens: positiveInteger(env, "AGENT_VISION_MAX_TOKENS", 4096),
    timeoutMs: positiveInteger(env, "AGENT_VISION_TIMEOUT_MS", 120_000),
    headers: parseHeaders(env.AGENT_VISION_HEADERS),
    maxImageBytes:
      positiveInteger(env, "AGENT_VISION_MAX_IMAGE_MB", 20) * 1024 * 1024,
    maxVideoBytes:
      positiveInteger(env, "AGENT_VISION_MAX_VIDEO_MB", 200) * 1024 * 1024,
    allowPrivateUrls:
      env.AGENT_VISION_ALLOW_PRIVATE_URLS?.trim().toLowerCase() === "true",
  };
}

export function requireModel(config: VisionConfig): void {
  if (!config.model) {
    throw new VisionError(
      "CONFIG_ERROR",
      "Set AGENT_VISION_MODEL (or VISION_MODEL / OPENAI_MODEL)",
    );
  }
}

export function chatCompletionsUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new VisionError(
      "CONFIG_ERROR",
      `Invalid AGENT_VISION_BASE_URL: ${baseUrl}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new VisionError(
      "CONFIG_ERROR",
      "AGENT_VISION_BASE_URL must use http or https",
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/chat/completions")) {
    url.pathname = `${path}/chat/completions`;
  }
  return url.toString();
}
