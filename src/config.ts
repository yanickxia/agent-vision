import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { VisionError } from "./errors.js";

export interface ModelTarget {
  label: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
}

export interface VisionConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  targets: ModelTarget[];
  configFile?: string;
  maxTokens: number;
  timeoutMs: number;
  headers: Record<string, string>;
  maxImageBytes: number;
  maxVideoBytes: number;
  allowPrivateUrls: boolean;
  ffmpegPath?: string;
}

interface ProviderSettings {
  name?: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  headers?: Record<string, string>;
}

interface SettingsFile {
  providers?: ProviderSettings[];
  maxTokens?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  maxImageMb?: number;
  maxVideoMb?: number;
  allowPrivateUrls?: boolean;
  ffmpegPath?: string;
}

type Environment = Record<string, string | undefined>;

export type SettingsReader = (filePath: string) => string | undefined;

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

function stringRecord(value: unknown, where: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VisionError("CONFIG_ERROR", `${where} must be an object`);
  }
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new VisionError("CONFIG_ERROR", `${where}.${key} must be a string`);
    }
    headers[key] = entry;
  }
  return headers;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    return stringRecord(JSON.parse(raw), "AGENT_VISION_HEADERS");
  } catch (error) {
    if (error instanceof VisionError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new VisionError(
      "CONFIG_ERROR",
      `AGENT_VISION_HEADERS must be a JSON object of string values: ${detail}`,
    );
  }
}

function expandConfigPath(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return path.join(homedir(), raw.slice(2));
  return path.resolve(raw);
}

function resolveSettingsPath(env: Environment): { path: string; explicit: boolean } {
  const explicit = env.AGENT_VISION_CONFIG?.trim();
  if (explicit) return { path: expandConfigPath(explicit), explicit: true };
  const configRoot = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  return { path: path.join(configRoot, "agent-vision", "settings.json"), explicit: false };
}

function defaultSettingsReader(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new VisionError(
      "CONFIG_ERROR",
      `Could not read settings file ${filePath}: ${detail}`,
    );
  }
}

function positiveFileNumber(
  file: Record<string, unknown>,
  key: string,
  filePath: string,
): number | undefined {
  const raw = file[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new VisionError("CONFIG_ERROR", `${filePath}: ${key} must be a positive integer`);
  }
  return raw;
}

function parseProvider(entry: unknown, filePath: string): ProviderSettings {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new VisionError("CONFIG_ERROR", `${filePath}: each provider must be an object`);
  }
  const record = entry as Record<string, unknown>;
  const baseUrl = record.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new VisionError(
      "CONFIG_ERROR",
      `${filePath}: every provider needs a baseUrl string`,
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new VisionError(
      "CONFIG_ERROR",
      `${filePath}: invalid provider baseUrl: ${baseUrl}`,
    );
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new VisionError(
      "CONFIG_ERROR",
      `${filePath}: provider baseUrl must use http or https: ${baseUrl}`,
    );
  }
  const models = record.models;
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.some((model) => typeof model !== "string" || !model.trim())
  ) {
    throw new VisionError(
      "CONFIG_ERROR",
      `${filePath}: every provider needs a non-empty models array of strings`,
    );
  }
  const name = record.name;
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    throw new VisionError(
      "CONFIG_ERROR",
      `${filePath}: provider name must be a non-empty string`,
    );
  }
  const apiKey = record.apiKey;
  if (apiKey !== undefined && typeof apiKey !== "string") {
    throw new VisionError("CONFIG_ERROR", `${filePath}: provider apiKey must be a string`);
  }
  const headers = record.headers === undefined
    ? undefined
    : stringRecord(record.headers, `${filePath}: provider headers`);
  return {
    ...(name !== undefined ? { name } : {}),
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    models: models as string[],
    ...(headers !== undefined ? { headers } : {}),
  };
}

function parseSettings(raw: string, filePath: string): SettingsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new VisionError("CONFIG_ERROR", `${filePath} is not valid JSON: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VisionError("CONFIG_ERROR", `${filePath} must contain a JSON object`);
  }
  const file = parsed as Record<string, unknown>;
  let providers: ProviderSettings[] | undefined;
  if (file.providers !== undefined) {
    if (!Array.isArray(file.providers) || file.providers.length === 0) {
      throw new VisionError(
        "CONFIG_ERROR",
        `${filePath}: providers must be a non-empty array`,
      );
    }
    providers = file.providers.map((entry) => parseProvider(entry, filePath));
  }
  const allowPrivateUrls = file.allowPrivateUrls;
  if (allowPrivateUrls !== undefined && typeof allowPrivateUrls !== "boolean") {
    throw new VisionError(
      "CONFIG_ERROR",
      `${filePath}: allowPrivateUrls must be a boolean`,
    );
  }
  const ffmpegPath = file.ffmpegPath;
  if (ffmpegPath !== undefined && (typeof ffmpegPath !== "string" || !ffmpegPath.trim())) {
    throw new VisionError(
      "CONFIG_ERROR",
      `${filePath}: ffmpegPath must be a non-empty string`,
    );
  }
  const maxTokens = positiveFileNumber(file, "maxTokens", filePath);
  const timeoutMs = positiveFileNumber(file, "timeoutMs", filePath);
  const headers = file.headers === undefined
    ? undefined
    : stringRecord(file.headers, `${filePath}: headers`);
  const maxImageMb = positiveFileNumber(file, "maxImageMb", filePath);
  const maxVideoMb = positiveFileNumber(file, "maxVideoMb", filePath);
  return {
    ...(providers !== undefined ? { providers } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(maxImageMb !== undefined ? { maxImageMb } : {}),
    ...(maxVideoMb !== undefined ? { maxVideoMb } : {}),
    ...(allowPrivateUrls !== undefined ? { allowPrivateUrls } : {}),
    ...(ffmpegPath !== undefined ? { ffmpegPath } : {}),
  };
}

function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

export function loadConfig(
  env: Environment = process.env,
  readSettings: SettingsReader = defaultSettingsReader,
): VisionConfig {
  const settingsLocation = resolveSettingsPath(env);
  const rawSettings = readSettings(settingsLocation.path);
  let settings: SettingsFile | undefined;
  let configFile: string | undefined;
  if (rawSettings !== undefined) {
    settings = parseSettings(rawSettings, settingsLocation.path);
    configFile = settingsLocation.path;
  } else if (settingsLocation.explicit) {
    throw new VisionError(
      "CONFIG_ERROR",
      `AGENT_VISION_CONFIG file not found: ${settingsLocation.path}`,
    );
  }

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

  const maxTokens =
    settings?.maxTokens ?? positiveInteger(env, "AGENT_VISION_MAX_TOKENS", 4096);
  const timeoutMs =
    settings?.timeoutMs ?? positiveInteger(env, "AGENT_VISION_TIMEOUT_MS", 120_000);
  const headers = { ...parseHeaders(env.AGENT_VISION_HEADERS), ...settings?.headers };
  const maxImageMb =
    settings?.maxImageMb ?? positiveInteger(env, "AGENT_VISION_MAX_IMAGE_MB", 20);
  const maxVideoMb =
    settings?.maxVideoMb ?? positiveInteger(env, "AGENT_VISION_MAX_VIDEO_MB", 200);
  const allowPrivateUrls =
    settings?.allowPrivateUrls ??
    env.AGENT_VISION_ALLOW_PRIVATE_URLS?.trim().toLowerCase() === "true";
  const ffmpegPath =
    settings?.ffmpegPath?.trim() || env.AGENT_VISION_FFMPEG_PATH?.trim() || undefined;

  let targets: ModelTarget[];
  if (settings?.providers?.length) {
    const envApiKey = apiKey;
    targets = settings.providers.flatMap((provider) =>
      provider.models.map((model) => {
        const targetApiKey = provider.apiKey ?? envApiKey;
        return {
          label: `${provider.name ?? hostOf(provider.baseUrl)}/${model}`,
          model,
          baseUrl: provider.baseUrl,
          ...(targetApiKey ? { apiKey: targetApiKey } : {}),
          headers: { ...headers, ...provider.headers },
        };
      }),
    );
  } else {
    targets = model
      ? [{
          label: model,
          model,
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          headers,
        }]
      : [];
  }

  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    model,
    targets,
    ...(configFile ? { configFile } : {}),
    maxTokens,
    timeoutMs,
    headers,
    maxImageBytes: maxImageMb * 1024 * 1024,
    maxVideoBytes: maxVideoMb * 1024 * 1024,
    allowPrivateUrls,
    ...(ffmpegPath ? { ffmpegPath } : {}),
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new VisionError("CONFIG_ERROR", `Invalid AGENT_VISION_BASE_URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new VisionError("CONFIG_ERROR", "AGENT_VISION_BASE_URL must use http or https");
  }
  const pathName = url.pathname.replace(/\/+$/, "");
  if (!pathName.endsWith("/chat/completions")) {
    url.pathname = `${pathName}/chat/completions`;
  }
  return url.toString();
}
