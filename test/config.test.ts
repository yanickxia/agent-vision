import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chatCompletionsUrl, loadConfig } from "../src/config.js";

test("agent-vision variables take precedence over aliases", () => {
  const config = loadConfig({
    AGENT_VISION_API_KEY: "agent-key",
    VISION_API_KEY: "vision-key",
    OPENAI_API_KEY: "openai-key",
    AGENT_VISION_BASE_URL: "https://agent.example/v1",
    VISION_BASE_URL: "https://vision.example/v1",
    AGENT_VISION_MODEL: "agent-model",
    VISION_MODEL: "vision-model",
  });
  assert.equal(config.apiKey, "agent-key");
  assert.equal(config.baseUrl, "https://agent.example/v1");
  assert.equal(config.model, "agent-model");
});

test("OpenAI aliases work and an API key is optional", () => {
  const config = loadConfig({
    OPENAI_BASE_URL: "http://localhost:1234/v1",
    OPENAI_MODEL: "local-model",
  });
  assert.equal(config.apiKey, undefined);
  assert.equal(config.model, "local-model");
  assert.equal(config.baseUrl, "http://localhost:1234/v1");
});

test("chat completions path is appended exactly once", () => {
  assert.equal(
    chatCompletionsUrl("https://example.com/v1"),
    "https://example.com/v1/chat/completions",
  );
  assert.equal(
    chatCompletionsUrl("https://example.com/v1/chat/completions"),
    "https://example.com/v1/chat/completions",
  );
});

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
    '{ "providers": [{ "baseUrl": "https://x.example/v1", "models": ["m"] }], "maxTokens": "big" }',
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
