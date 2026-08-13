import assert from "node:assert/strict";
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
