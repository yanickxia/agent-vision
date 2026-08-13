import type { VisionConfig } from "../src/config.js";

export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export function testConfig(overrides: Partial<VisionConfig> = {}): VisionConfig {
  return {
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "test-vision-model",
    maxTokens: 512,
    timeoutMs: 10_000,
    headers: {},
    maxImageBytes: 2 * 1024 * 1024,
    maxVideoBytes: 20 * 1024 * 1024,
    allowPrivateUrls: true,
    ...overrides,
  };
}
