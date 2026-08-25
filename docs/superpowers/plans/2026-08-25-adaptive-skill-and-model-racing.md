# agent-vision 自适应 Skill 与多模型竞速 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skill 改为能力自适应（有原生视觉就直接看、纯文本 Agent 跑 CLI、不再引导 MCP），并支持 `~/.config/agent-vision/settings.json` 多 provider 多模型并发竞速、首成功胜出。

**Architecture:** 配置层（config.ts）负责发现/解析 settings.json 并把 providers×models 扁平化为 `targets`；provider 层新增 `raceVisionCompletions` 并发请求所有 target、首成功胜出并 abort 败者；analyze/server/CLI 接线不变（仅 analyze 内部换调用）。spec 见 `docs/superpowers/specs/2026-08-25-adaptive-skill-and-model-racing-design.md`。

**Tech Stack:** Node.js 20+/TypeScript ESM、node:test、MCP SDK（不动）。

**约定:** 每个任务 TDD（先写失败测试）、完成后 commit。测试命令一律 `npm test`（内含 build）。仓库为 trunk-based，直接提交 main。

---

### Task 1: 配置层 —— settings.json 解析与 targets 展开

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`
- Modify: `test/helpers.ts`

本任务保留 `apiKey`/`baseUrl`/`model` 三个旧字段（Task 2 移除），保证编译与测试全程绿。

- [ ] **Step 1: 写失败的测试**

在 `test/config.test.ts` 顶部 import 增加：

```ts
import { homedir } from "node:os";
import path from "node:path";
```

文件末尾追加：

```ts
test("settings file providers expand into racing targets", () => {
  const settings = JSON.stringify({
    providers: [
      {
        name: "dashscope",
        baseUrl: "https://dash.example/v1",
        apiKey: "dash-key",
        models: ["model-a", "model-b"],
      },
      {
        baseUrl: "https://other.example/v1",
        models: ["model-c"],
        headers: { "x-extra": "1" },
      },
    ],
    maxTokens: 128,
  });
  const config = loadConfig(
    {
      XDG_CONFIG_HOME: "/xdg-home",
      AGENT_VISION_API_KEY: "env-key",
      AGENT_VISION_MODEL: "env-model",
    },
    () => settings,
  );
  assert.equal(config.configFile, "/xdg-home/agent-vision/settings.json");
  assert.equal(config.maxTokens, 128);
  assert.deepEqual(
    config.targets.map((t) => [t.label, t.model, t.baseUrl, t.apiKey]),
    [
      ["dashscope/model-a", "model-a", "https://dash.example/v1", "dash-key"],
      ["dashscope/model-b", "model-b", "https://dash.example/v1", "dash-key"],
      ["other.example/model-c", "model-c", "https://other.example/v1", "env-key"],
    ],
  );
  assert.deepEqual(config.targets[2]?.headers, { "x-extra": "1" });
});

test("AGENT_VISION_CONFIG points at an explicit settings file", () => {
  const seen: string[] = [];
  const config = loadConfig({ AGENT_VISION_CONFIG: "~/agent-vision.json" }, (filePath) => {
    seen.push(filePath);
    return JSON.stringify({
      providers: [{ name: "p", baseUrl: "https://p.example/v1", models: ["m"] }],
    });
  });
  assert.equal(seen[0], path.join(homedir(), "agent-vision.json"));
  assert.deepEqual(
    config.targets.map((t) => t.label),
    ["p/m"],
  );
});

test("a missing AGENT_VISION_CONFIG file is a configuration error", () => {
  assert.throws(
    () => loadConfig({ AGENT_VISION_CONFIG: "/nowhere/settings.json" }, () => undefined),
    (error: Error & { code?: string }) =>
      error.code === "CONFIG_ERROR" && /\/nowhere\/settings\.json/.test(error.message),
  );
});

test("invalid settings files produce a clear error naming the file", () => {
  const cases = [
    "not json",
    "[]",
    '{ "providers": [] }',
    '{ "providers": [{ "baseUrl": "https://x.example/v1" }] }',
    '{ "providers": [{ "baseUrl": "https://x.example/v1", "models": [] }] }',
    '{ "providers": [{ "baseUrl": "not a url", "models": ["m"] }] }',
    '{ "providers": [{ "baseUrl": "https://x.example/v1", "models": ["m"], "maxTokens": "big" }] }',
    '{ "maxTokens": -1 }',
  ];
  for (const raw of cases) {
    assert.throws(
      () => loadConfig({ XDG_CONFIG_HOME: "/xdg-home" }, () => raw),
      (error: Error & { code?: string }) =>
        error.code === "CONFIG_ERROR" && /settings\.json/.test(error.message),
    );
  }
});

test("settings file knobs override environment variables", () => {
  const config = loadConfig(
    {
      XDG_CONFIG_HOME: "/xdg-home",
      AGENT_VISION_MAX_TOKENS: "999",
      AGENT_VISION_TIMEOUT_MS: "5",
    },
    () =>
      JSON.stringify({
        maxTokens: 128,
        timeoutMs: 250,
        providers: [{ name: "p", baseUrl: "https://p.example/v1", models: ["m"] }],
      }),
  );
  assert.equal(config.maxTokens, 128);
  assert.equal(config.timeoutMs, 250);
});

test("without a settings file the environment configures a single target", () => {
  const config = loadConfig(
    {
      XDG_CONFIG_HOME: "/xdg-home",
      AGENT_VISION_MODEL: "env-model",
      AGENT_VISION_BASE_URL: "https://env.example/v1",
      AGENT_VISION_API_KEY: "env-key",
    },
    () => undefined,
  );
  assert.equal(config.configFile, undefined);
  assert.deepEqual(
    config.targets.map((t) => [t.label, t.model, t.baseUrl, t.apiKey]),
    [["env-model", "env-model", "https://env.example/v1", "env-key"]],
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test 2>&1 | tail -20`
Expected: 编译报错或断言失败（`config.targets` 不存在）。

- [ ] **Step 3: 实现 config.ts**

`src/config.ts` 全量替换为：

```ts
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
  return {
    ...(providers !== undefined ? { providers } : {}),
    maxTokens: positiveFileNumber(file, "maxTokens", filePath),
    timeoutMs: positiveFileNumber(file, "timeoutMs", filePath),
    headers: file.headers === undefined
      ? undefined
      : stringRecord(file.headers, `${filePath}: headers`),
    maxImageMb: positiveFileNumber(file, "maxImageMb", filePath),
    maxVideoMb: positiveFileNumber(file, "maxVideoMb", filePath),
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
      provider.models.map((model) => ({
        label: `${provider.name ?? hostOf(provider.baseUrl)}/${model}`,
        model,
        baseUrl: provider.baseUrl,
        ...(provider.apiKey ?? envApiKey
          ? { apiKey: provider.apiKey ?? envApiKey }
          : {}),
        headers: { ...headers, ...provider.headers },
      })),
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
```

注意：`requireModel` 已删除（其职责移入 Task 2 的 `raceVisionCompletions`）。

- [ ] **Step 4: 更新 helpers.ts**

`test/helpers.ts` 全量替换为：

```ts
import type { ModelTarget, VisionConfig } from "../src/config.js";

export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export function testTarget(overrides: Partial<ModelTarget> = {}): ModelTarget {
  return {
    label: "test-vision-model",
    model: "test-vision-model",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "test-key",
    headers: {},
    ...overrides,
  };
}

export function testConfig(overrides: Partial<VisionConfig> = {}): VisionConfig {
  return {
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "test-vision-model",
    targets: [testTarget()],
    maxTokens: 512,
    timeoutMs: 10_000,
    headers: {},
    maxImageBytes: 2 * 1024 * 1024,
    maxVideoBytes: 20 * 1024 * 1024,
    allowPrivateUrls: true,
    ...overrides,
  };
}
```

- [ ] **Step 5: 修补 provider.ts 编译并运行全部测试**

`src/provider.ts`：顶部 import 改为 `import { chatCompletionsUrl } from "./config.js";`，删除 `requireModel(options.config);` 一行（其余不动）。

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts test/helpers.ts src/provider.ts
git commit -m "feat: parse multi-provider settings.json into racing targets"
```

---

### Task 2: 竞速层 —— requestVisionCompletion target 化 + raceVisionCompletions

**Files:**
- Modify: `src/provider.ts`
- Modify: `src/analyze.ts`
- Modify: `src/config.ts`（移除旧字段）
- Modify: `test/provider.test.ts`
- Modify: `test/config.test.ts`
- Modify: `test/helpers.ts`

- [ ] **Step 1: 写失败的测试**

`test/provider.test.ts` 顶部 import 改为：

```ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { raceVisionCompletions, requestVisionCompletion } from "../src/provider.js";
import { TINY_PNG, testConfig, testTarget } from "./helpers.js";
```

原有两个测试中的 `config: testConfig({ baseUrl: ... })` 一律替换为两行：

```ts
config: testConfig(),
target: testTarget({ baseUrl: `http://127.0.0.1:${address.port}/v1` }),
```

（两处，其余断言不变。）

文件末尾追加：

```ts
test("racing targets uses the first success and aborts the losers", async () => {
  let slowAborted = false;
  const server = createServer((request, response) => {
    if (request.url === "/v1/slow/chat/completions") {
      const timer = setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: { content: "slow result" } }],
        }));
      }, 400);
      request.on("close", () => {
        slowAborted = true;
        clearTimeout(timer);
      });
      return;
    }
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "fast result" } }],
      }));
    }, 20);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const port = address.port;
    const result = await raceVisionCompletions({
      config: testConfig({
        targets: [
          testTarget({ label: "slow", baseUrl: `http://127.0.0.1:${port}/v1/slow` }),
          testTarget({ label: "fast", baseUrl: `http://127.0.0.1:${port}/v1/fast` }),
        ],
      }),
      prompt: "test",
      images: [{ dataUrl: `data:image/png;base64,${TINY_PNG.toString("base64")}` }],
    });
    assert.equal(result.text, "fast result");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(slowAborted, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a fast failure does not beat a slow success", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/fail/chat/completions") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "boom" } }));
      return;
    }
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "late result" } }],
      }));
    }, 80);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const port = address.port;
    const result = await raceVisionCompletions({
      config: testConfig({
        targets: [
          testTarget({ label: "fail", baseUrl: `http://127.0.0.1:${port}/v1/fail` }),
          testTarget({ label: "late", baseUrl: `http://127.0.0.1:${port}/v1/late` }),
        ],
      }),
      prompt: "test",
      images: [{ dataUrl: `data:image/png;base64,${TINY_PNG.toString("base64")}` }],
    });
    assert.equal(result.text, "late result");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("aggregates failures when every target fails", async () => {
  const server = createServer((request, response) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: { message: request.url?.includes("alpha") ? "alpha broke" : "beta broke" },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const port = address.port;
    await assert.rejects(
      raceVisionCompletions({
        config: testConfig({
          targets: [
            testTarget({ label: "alpha/a", baseUrl: `http://127.0.0.1:${port}/v1/alpha` }),
            testTarget({ label: "beta/b", baseUrl: `http://127.0.0.1:${port}/v1/beta` }),
          ],
        }),
        prompt: "test",
        images: [{ dataUrl: `data:image/png;base64,${TINY_PNG.toString("base64")}` }],
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "API_ERROR");
        assert.match(error.message, /All vision model targets failed/);
        assert.match(error.message, /alpha\/a: API_ERROR: Vision API returned HTTP 500: alpha broke/);
        assert.match(error.message, /beta\/b: API_ERROR: Vision API returned HTTP 500: beta broke/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a single target keeps the direct error format", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "invalid credentials" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    await assert.rejects(
      raceVisionCompletions({
        config: testConfig({
          targets: [testTarget({ baseUrl: `http://127.0.0.1:${address.port}/v1` })],
        }),
        prompt: "test",
        images: [{ dataUrl: `data:image/png;base64,${TINY_PNG.toString("base64")}` }],
      }),
      (error: Error) => {
        assert.match(error.message, /HTTP 401: invalid credentials/);
        assert.doesNotMatch(error.message, /All vision model targets failed/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("an empty target list is a configuration error", async () => {
  await assert.rejects(
    raceVisionCompletions({
      config: testConfig({ targets: [] }),
      prompt: "test",
      images: [{ dataUrl: `data:image/png;base64,${TINY_PNG.toString("base64")}` }],
    }),
    (error: Error & { code?: string }) =>
      error.code === "CONFIG_ERROR" && /AGENT_VISION_MODEL/.test(error.message),
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test 2>&1 | tail -30`
Expected: 新测试 FAIL（`raceVisionCompletions` 未导出）。

- [ ] **Step 3: 实现 provider.ts**

`src/provider.ts` 全量替换为：

```ts
import type { ModelTarget, VisionConfig } from "./config.js";
import { chatCompletionsUrl } from "./config.js";
import { VisionError, errorMessage } from "./errors.js";

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
  target: ModelTarget;
  prompt: string;
  images: VisionInputImage[];
  signal?: AbortSignal;
}): Promise<VisionCompletion> {
  if (!options.target.model) {
    throw new VisionError("CONFIG_ERROR", "A vision model target is missing a model name");
  }
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

  const headers = new Headers(options.target.headers);
  headers.set("content-type", "application/json");
  if (options.target.apiKey && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${options.target.apiKey}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.config.timeoutMs);
  const external = options.signal;
  const onExternalAbort = () => controller.abort();
  if (external?.aborted) controller.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  let response: Response;
  let raw: string;
  try {
    response = await fetch(chatCompletionsUrl(options.target.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: options.target.model,
        messages: [{ role: "user", content }],
        max_tokens: options.config.maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    raw = await response.text();
  } catch (error) {
    if (external?.aborted) {
      throw new VisionError(
        "API_ABORTED",
        "Request aborted because another vision model target finished first",
      );
    }
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
    external?.removeEventListener("abort", onExternalAbort);
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
    model: typeof record.model === "string" ? record.model : options.target.model,
    ...(record.usage && typeof record.usage === "object"
      ? { usage: record.usage as Record<string, unknown> }
      : {}),
  };
}

export async function raceVisionCompletions(options: {
  config: VisionConfig;
  prompt: string;
  images: VisionInputImage[];
}): Promise<VisionCompletion> {
  const targets = options.config.targets;
  if (targets.length === 0) {
    throw new VisionError(
      "CONFIG_ERROR",
      "No vision model configured. Add providers to the settings file or set AGENT_VISION_MODEL (or VISION_MODEL / OPENAI_MODEL)",
    );
  }
  if (targets.length === 1) {
    return requestVisionCompletion({
      config: options.config,
      target: targets[0],
      prompt: options.prompt,
      images: options.images,
    });
  }

  const attempts = targets.map((target) => {
    const controller = new AbortController();
    return {
      target,
      controller,
      promise: requestVisionCompletion({
        config: options.config,
        target,
        prompt: options.prompt,
        images: options.images,
        signal: controller.signal,
      }),
    };
  });

  return new Promise<VisionCompletion>((resolve, reject) => {
    let pending = attempts.length;
    const failures: string[] = [];
    for (const attempt of attempts) {
      attempt.promise.then(
        (result) => {
          for (const other of attempts) {
            if (other !== attempt && !other.controller.signal.aborted) {
              other.controller.abort();
            }
          }
          resolve(result);
        },
        (error: unknown) => {
          failures.push(`${attempt.target.label}: ${errorMessage(error)}`);
          pending -= 1;
          if (pending === 0) {
            reject(
              new VisionError(
                "API_ERROR",
                `All vision model targets failed:\n${failures.join("\n")}`,
              ),
            );
          }
        },
      );
    }
  });
}
```

- [ ] **Step 4: 更新 analyze.ts**

`src/analyze.ts` import 行改为：

```ts
import { raceVisionCompletions, type VisionCompletion } from "./provider.js";
```

两处 `requestVisionCompletion({` 调用改为 `raceVisionCompletions({`（参数结构一致，函数体其余不变）。

- [ ] **Step 5: 移除 VisionConfig 旧字段**

`src/config.ts`：
- `VisionConfig` 删除 `apiKey?: string;`、`baseUrl: string;`、`model: string;` 三行。
- `loadConfig` 返回值删除 `...(apiKey ? { apiKey } : {}),`、`baseUrl,`、`model,` 三行（局部变量保留，构建 env 回退 target 用）。

`test/helpers.ts`：`testConfig` 删除 `apiKey: "test-key",`、`baseUrl: "http://127.0.0.1:1/v1",`、`model: "test-vision-model",` 三行。

`test/config.test.ts`：前两个旧测试替换为：

```ts
test("agent-vision variables take precedence over aliases", () => {
  const config = loadConfig({
    XDG_CONFIG_HOME: "/nonexistent-agent-vision-test",
    AGENT_VISION_API_KEY: "agent-key",
    VISION_API_KEY: "vision-key",
    OPENAI_API_KEY: "openai-key",
    AGENT_VISION_BASE_URL: "https://agent.example/v1",
    VISION_BASE_URL: "https://vision.example/v1",
    AGENT_VISION_MODEL: "agent-model",
    VISION_MODEL: "vision-model",
  });
  assert.equal(config.targets.length, 1);
  assert.equal(config.targets[0]?.apiKey, "agent-key");
  assert.equal(config.targets[0]?.baseUrl, "https://agent.example/v1");
  assert.equal(config.targets[0]?.model, "agent-model");
});

test("OpenAI aliases work and an API key is optional", () => {
  const config = loadConfig({
    XDG_CONFIG_HOME: "/nonexistent-agent-vision-test",
    OPENAI_BASE_URL: "http://localhost:1234/v1",
    OPENAI_MODEL: "local-model",
  });
  assert.equal(config.targets.length, 1);
  assert.equal(config.targets[0]?.apiKey, undefined);
  assert.equal(config.targets[0]?.model, "local-model");
  assert.equal(config.targets[0]?.baseUrl, "http://localhost:1234/v1");
});
```

- [ ] **Step 6: 运行全部测试确认通过**

Run: `npm test`
Expected: 全部 PASS（含 mcp/image/video——analyze 走单 target 路径，行为不变）。

- [ ] **Step 7: Commit**

```bash
git add src/provider.ts src/analyze.ts src/config.ts test/provider.test.ts test/config.test.ts test/helpers.ts
git commit -m "feat: race concurrent model targets, first success wins"
```

---

### Task 3: CLI doctor 与 ffmpegPath 接线 + MCP 测试隔离

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/video.ts`
- Modify: `test/mcp.test.ts`
- Create: `test/doctor.test.ts`

- [ ] **Step 1: 写失败的测试**

新建 `test/doctor.test.ts`：

```ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function runDoctor(env: NodeJS.ProcessEnv): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/cli.js"), "doctor"], {
      cwd: path.resolve("."),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
  });
}

test("doctor reports environment targets when no settings file exists", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-vision-doctor-test-"));
  try {
    const { stdout, code } = await runDoctor({
      XDG_CONFIG_HOME: directory,
      AGENT_VISION_MODEL: "env-model",
      AGENT_VISION_BASE_URL: "https://env.example/v1",
      AGENT_VISION_API_KEY: "env-key",
    });
    assert.equal(code, 0);
    assert.match(stdout, /config file: not found/);
    assert.match(stdout, /env-model\s+https:\/\/env\.example\/v1\s+key: configured/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor lists settings file targets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-vision-doctor-test-"));
  try {
    const xdgRoot = path.join(directory, "xdg");
    await mkdir(path.join(xdgRoot, "agent-vision"), { recursive: true });
    await writeFile(
      path.join(xdgRoot, "agent-vision", "settings.json"),
      JSON.stringify({
        providers: [
          { name: "dashscope", baseUrl: "https://dash.example/v1", models: ["a", "b"] },
        ],
      }),
    );
    const { stdout, code } = await runDoctor({
      XDG_CONFIG_HOME: xdgRoot,
      AGENT_VISION_MODEL: "env-model",
    });
    assert.equal(code, 0);
    assert.match(stdout, /config file: .*settings\.json/);
    assert.match(stdout, /dashscope\/a\s+https:\/\/dash\.example\/v1\s+key: not configured/);
    assert.match(stdout, /dashscope\/b/);
    assert.doesNotMatch(stdout, /env-model/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

`test/mcp.test.ts` 的 `env:` 块增加一行 XDG 隔离：

```ts
    env: {
      ...process.env,
      XDG_CONFIG_HOME: directory,
      AGENT_VISION_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AGENT_VISION_API_KEY: "mock-key",
      AGENT_VISION_MODEL: "mock-model",
    },
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test 2>&1 | tail -30`
Expected: doctor 测试 FAIL（输出无 `config file:` / `targets:` 行）。

- [ ] **Step 3: 实现 doctor 输出**

`src/cli.ts` 的 `doctor` 分支整体替换为：

```ts
  if (command === "doctor") {
    const config = loadConfig();
    let ffmpeg = "unavailable";
    try {
      ffmpeg = await ensureFfmpeg(config.ffmpegPath);
    } catch {
      // Report below without failing before the full doctor output is printed.
    }
    const lines = [
      `config file: ${config.configFile ?? "not found (using environment variables)"}`,
    ];
    if (config.targets.length === 0) {
      lines.push("targets: none configured");
    } else {
      lines.push("targets:");
      config.targets.forEach((target, index) => {
        lines.push(
          `  ${index + 1}. ${target.label}  ${target.baseUrl}  key: ${target.apiKey ? "configured" : "not configured"}`,
        );
      });
    }
    lines.push(`ffmpeg: ${ffmpeg}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    if (config.targets.length === 0 || ffmpeg === "unavailable") process.exitCode = 1;
    return;
  }
```

- [ ] **Step 4: ffmpegPath 接线**

`src/video.ts`：

1. `ensureFfmpeg` 签名与首行：

```ts
export function ensureFfmpeg(configuredPath?: string): Promise<string> {
  ffmpegReady ??= (async () => {
    const configured = configuredPath?.trim() || process.env.AGENT_VISION_FFMPEG_PATH?.trim();
```

（函数体其余不变。）

2. `runFfmpeg` 增加第四个参数：

```ts
async function runFfmpeg(
  args: string[],
  allowFailure = false,
  timeoutMs = 120_000,
  configuredPath?: string,
): Promise<string> {
  const command = await ensureFfmpeg(configuredPath);
```

3. `videoDuration` 增加参数并透传：

```ts
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
```

4. `extractVideoFrames` 内两处调用透传 `options.config.ffmpegPath`：

```ts
    const duration = await videoDuration(
      inputPath,
      options.config.timeoutMs,
      options.config.ffmpegPath,
    );
```

```ts
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
```

- [ ] **Step 5: 运行全部测试确认通过**

Run: `npm test`
Expected: 全部 PASS（本机无 ffmpeg 时 doctor 用例可能 exit 1——检查 `@ffmpeg-installer/ffmpeg` 是否已安装，必要时 `npm install`）。

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/video.ts test/doctor.test.ts test/mcp.test.ts
git commit -m "feat: doctor lists racing targets and honors ffmpegPath from settings"
```

---

### Task 4: Skill 重写

**Files:**
- Modify: `skills/agent-vision/SKILL.md`
- Modify: `skills/agent-vision/references/configuration.md`

- [ ] **Step 1: 重写 SKILL.md**

全量替换为：

````markdown
---
name: agent-vision
description: Analyze images, screenshots, diagrams, and videos you cannot see natively. Use for image questions, OCR, UI inspection, visual debugging, screen recordings, video summaries, and timeline analysis on text-only agents.
license: MIT
compatibility: Node.js 20+ for the CLI; the MCP server is optional.
---

# agent-vision

Use this skill when the user asks about an image or a video.

## Look first

If you can read images natively (for example the Read tool in Claude Code or
built-in multimodal input), look at the image yourself and answer directly.
Do not call any external tool for an image you can already see.

Videos are the exception: no agent can watch a video natively. Video analysis
always goes through the CLI below.

## Run the CLI

When you cannot see the input yourself (or it is a video), run the analysis
directly and read the plain-text output:

```bash
npx -y @yanickxia/agent-vision image "/absolute/path/to/error.png" --prompt "Read the error message and identify the likely cause."
npx -y @yanickxia/agent-vision video "/absolute/path/to/demo.mp4" --prompt "Summarize the UI flow in chronological order." --frames 8
```

If the package is installed locally, run `agent-vision image ...` instead of
`npx -y @yanickxia/agent-vision ...`.

## Calling rules

1. Pass the user's original question as `--prompt`. A focused question is
   better than a generic request for a description.
2. Prefer an absolute local path. HTTP(S) URLs are also supported. Images may
   additionally be supplied as a `data:image/...;base64,...` URI.
3. For videos, keep the default `--frames 8` unless the user needs a faster
   result or a denser timeline. The allowed range is 1–16.
4. If the result is uncertain, say so. Never invent visual details after a
   failed run.
5. Retry at most once for a transient API or timeout error. Configuration,
   unsupported-format, and missing-file errors require correction, not retries.

Configuration — multiple providers and models raced concurrently — is
described in `references/configuration.md`.
````

- [ ] **Step 2: 重写 references/configuration.md**

全量替换为：

````markdown
# Configuration

agent-vision reads its configuration from a JSON settings file. Environment
variables still work as a fallback.

## Settings file

The first location that exists wins:

1. `$AGENT_VISION_CONFIG` — an explicit file path (an error if it is missing)
2. `$XDG_CONFIG_HOME/agent-vision/settings.json`
   (default: `~/.config/agent-vision/settings.json`)

```json
{
  "providers": [
    {
      "name": "dashscope",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKey": "sk-...",
      "models": ["qwen-vl-max", "qwen-vl-plus"]
    },
    {
      "name": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "models": ["gpt-4o"]
    }
  ],
  "maxTokens": 4096,
  "timeoutMs": 120000
}
```

- Every provider × model combination is a target. With several targets, all
  of them are requested **concurrently** and the first successful answer
  wins; the remaining requests are aborted. Note the cost: N targets means
  up to N paid completions per analysis.
- `name` is optional and only used in error messages; it defaults to the
  baseUrl host.
- `apiKey` is optional per provider (for local endpoints without auth) and
  falls back to the environment key.
- `headers` per provider merges over the top-level `headers`.
- Top-level knobs (all optional): `maxTokens`, `timeoutMs`, `headers`,
  `maxImageMb`, `maxVideoMb`, `allowPrivateUrls`, `ffmpegPath`.
- Fields defined in the file take precedence over environment variables.
- The file may contain API keys: keep it out of version control and run
  `chmod 600` on it.

## Environment variables (fallback)

Required when no settings file is used:

```bash
export AGENT_VISION_BASE_URL="https://your-openai-compatible-endpoint/v1"
export AGENT_VISION_API_KEY="your-key"
export AGENT_VISION_MODEL="your-vision-model"
```

`AGENT_VISION_API_KEY` may be omitted for a trusted local endpoint that does
not require authentication. The server also recognizes `VISION_*` and
`OPENAI_*` aliases.

Optional variables:

- `AGENT_VISION_MAX_TOKENS` (default `4096`)
- `AGENT_VISION_TIMEOUT_MS` (default `120000`)
- `AGENT_VISION_MAX_IMAGE_MB` (default `20`)
- `AGENT_VISION_MAX_VIDEO_MB` (default `200`)
- `AGENT_VISION_HEADERS` (JSON object of extra HTTP headers)
- `AGENT_VISION_ALLOW_PRIVATE_URLS=true` (allow private image/video source URLs)
- `AGENT_VISION_FFMPEG_PATH` (override ffmpeg; otherwise PATH, then bundled binary)

The configured API endpoint itself may be private; the private-URL guard only
applies to user-provided image and video source URLs.
````

- [ ] **Step 3: 检查与提交**

Run: `grep -ri "mcp" skills/agent-vision/ || echo clean`
Expected: `clean`。

```bash
git add skills/agent-vision
git commit -m "feat: rewrite skill as capability-adaptive with CLI as execution path"
```

---

### Task 5: README 更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新定位与配置章节**

1. 开头 bullet 列表中 `- 单一 provider，无免费模型列表、fallback 竞速、watchdog 或透明代理` 替换为：

```markdown
- 多 provider 多模型并发竞速：所有 target 同时请求，谁先成功用谁，其余请求 abort
```

2. 「## 配置」整节（到「## MCP 安装」之前）替换为：

````markdown
## 配置

推荐用配置文件（一次配置，所有宿主共用）：

```bash
mkdir -p ~/.config/agent-vision
cat > ~/.config/agent-vision/settings.json <<'EOF'
{
  "providers": [
    {
      "name": "dashscope",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKey": "sk-...",
      "models": ["qwen-vl-max", "qwen-vl-plus"]
    },
    {
      "name": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "models": ["gpt-4o"]
    }
  ]
}
EOF
chmod 600 ~/.config/agent-vision/settings.json
```

- 位置：`$AGENT_VISION_CONFIG` 显式路径，或 `$XDG_CONFIG_HOME/agent-vision/settings.json`（默认 `~/.config/agent-vision/settings.json`）
- 每个 provider × model 是一个 target；多个 target 时**并发请求，第一个成功者胜出**，其余请求 abort。注意成本：N 个 target 意味着每次分析最多 N 份上传与推理费用
- provider 字段：`baseUrl`（必填）、`models`（必填非空）、`name`/`apiKey`/`headers`（可选；`apiKey` 缺省回退环境变量）
- 顶层可选：`maxTokens`、`timeoutMs`、`headers`、`maxImageMb`、`maxVideoMb`、`allowPrivateUrls`、`ffmpegPath`
- 文件定义的字段优先于环境变量；含 key 的文件建议 `chmod 600`

环境变量作为回退仍然完整支持（无配置文件时）：

| 设置 | 兼容回退 |
|---|---|
| `AGENT_VISION_API_KEY` | `VISION_API_KEY` → `OPENAI_API_KEY` |
| `AGENT_VISION_BASE_URL` | `VISION_BASE_URL` → `OPENAI_BASE_URL` |
| `AGENT_VISION_MODEL` | `VISION_MODEL` → `OPENAI_MODEL` |

可选变量：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `AGENT_VISION_MAX_TOKENS` | `4096` | 最大输出 tokens |
| `AGENT_VISION_TIMEOUT_MS` | `120000` | 下载和 API 超时 |
| `AGENT_VISION_MAX_IMAGE_MB` | `20` | 图片大小上限 |
| `AGENT_VISION_MAX_VIDEO_MB` | `200` | 视频大小上限 |
| `AGENT_VISION_HEADERS` | `{}` | 额外请求头 JSON |
| `AGENT_VISION_ALLOW_PRIVATE_URLS` | `false` | 允许私网图片/视频来源 URL |
| `AGENT_VISION_FFMPEG_PATH` | 自动发现 | 指定 ffmpeg 可执行文件；默认先用 PATH，再用 npm 内置版本 |
````

3. `## MCP 安装` 下 npm 示例的 `env` 块删除，变为：

```json
{
  "mcpServers": {
    "agent-vision": {
      "command": "npx",
      "args": ["-y", "@yanickxia/agent-vision"]
    }
  }
}
```

GitHub 示例同样删掉 `env` 块；OpenCode 示例删掉 `environment` 块。紧接示例后加：

```markdown
无需 env 块：配置从 `~/.config/agent-vision/settings.json` 读取（见上文「配置」）。
也可以继续用环境变量，在 `env` / `environment` 块里传入。
```

4. 「Agent Skill」一节中：

```markdown
也可以复制 `skills/agent-vision/` 到 Agent 的 skills 目录。Skill 负责告诉
Agent 何时调用图片/视频工具、如何传参和如何处理失败；MCP 负责实际读取文件、
抽帧和请求模型。
```

替换为：

```markdown
也可以复制 `skills/agent-vision/` 到 Agent 的 skills 目录。Skill 是能力自适应
的：Agent 自己能看图就直接看；看不了（或输入是视频）就由 Skill 指导 Agent
直接跑 CLI 完成分析。
```

- [ ] **Step 2: 检查与提交**

Run: `grep -n "fallback 竞速\|单一 provider" README.md || echo clean`
Expected: `clean`。

```bash
git add README.md
git commit -m "docs: document settings.json providers and racing in README"
```

---

### Task 6: 全量验证与收尾

**Files:** 无新改动（只验证）。

- [ ] **Step 1: 类型检查与全量测试**

Run: `npm run typecheck && npm test`
Expected: 0 错误、全部测试 PASS。

- [ ] **Step 2: 打包检查**

Run: `npm pack --dry-run`
Expected: 包含 `dist/`、`skills/`，无测试文件混入。

- [ ] **Step 3: 端到端冒烟**

```bash
tmp=$(mktemp -d) && mkdir -p "$tmp/agent-vision"
cat > "$tmp/agent-vision/settings.json" <<'EOF'
{ "providers": [{ "name": "demo", "baseUrl": "http://127.0.0.1:9/v1", "models": ["m1", "m2"] }] }
EOF
XDG_CONFIG_HOME="$tmp" node dist/cli.js doctor; echo "exit=$?"; rm -rf "$tmp"
```

Expected: 输出 `config file: .../settings.json` 与两行 target（`demo/m1`、`demo/m2`，`key: not configured`）。

- [ ] **Step 4: 汇报**

向用户汇报：改动清单、测试结果、竞速成本提示、skill 新行为。
