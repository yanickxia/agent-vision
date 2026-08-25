import type { VisionConfig } from "./config.js";
import { chatCompletionsUrl } from "./config.js";
import { VisionError } from "./errors.js";

export interface VisionInputImage {
  dataUrl: string;
  label?: string;
}

export interface VisionCompletion {
  text: string;
  model: string;
  usage?: Record<string, unknown>;
}

function responseText(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) return content.trim();
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((part) => {
      if (!part || typeof part !== "object") return undefined;
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string"
        ? value.text
        : undefined;
    })
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n").trim() : undefined;
}

export async function requestVisionCompletion(options: {
  config: VisionConfig;
  prompt: string;
  images: VisionInputImage[];
}): Promise<VisionCompletion> {
  if (options.images.length === 0) {
    throw new VisionError("INVALID_SOURCE", "At least one image is required");
  }

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: options.prompt },
  ];
  for (const [index, image] of options.images.entries()) {
    if (image.label) {
      content.push({ type: "text", text: `Image ${index + 1}: ${image.label}` });
    }
    content.push({
      type: "image_url",
      image_url: { url: image.dataUrl, detail: "high" },
    });
  }

  const headers = new Headers(options.config.headers);
  headers.set("content-type", "application/json");
  if (options.config.apiKey && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${options.config.apiKey}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.config.timeoutMs);
  let response: Response;
  let raw: string;
  try {
    response = await fetch(chatCompletionsUrl(options.config.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: options.config.model,
        messages: [{ role: "user", content }],
        max_tokens: options.config.maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    raw = await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new VisionError(
        "API_TIMEOUT",
        `Vision API timed out after ${options.config.timeoutMs} ms`,
      );
    }
    throw new VisionError("API_ERROR", "Could not reach the vision API", {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const record = payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : undefined;
    const error = record?.error;
    const apiMessage = error && typeof error === "object"
      ? (error as Record<string, unknown>).message
      : undefined;
    const detail = typeof apiMessage === "string"
      ? apiMessage
      : raw.slice(0, 500) || response.statusText;
    throw new VisionError(
      "API_ERROR",
      `Vision API returned HTTP ${response.status}: ${detail}`,
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new VisionError("API_RESPONSE_ERROR", "Vision API returned invalid JSON");
  }
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
  const message = firstChoice && typeof firstChoice === "object"
    ? (firstChoice as Record<string, unknown>).message
    : undefined;
  const contentValue = message && typeof message === "object"
    ? (message as Record<string, unknown>).content
    : undefined;
  const text = responseText(contentValue);
  if (!text) {
    throw new VisionError(
      "API_RESPONSE_ERROR",
      "Vision API response is missing choices[0].message.content",
    );
  }
  return {
    text,
    model: typeof record.model === "string" ? record.model : options.config.model,
    ...(record.usage && typeof record.usage === "object"
      ? { usage: record.usage as Record<string, unknown> }
      : {}),
  };
}
