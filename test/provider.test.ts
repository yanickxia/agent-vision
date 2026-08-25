import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { raceVisionCompletions, requestVisionCompletion } from "../src/provider.js";
import { TINY_PNG, testConfig, testTarget } from "./helpers.js";

test("sends OpenAI-compatible multimodal content and parses the response", async () => {
  let received: Record<string, unknown> | undefined;
  let authorization: string | undefined;
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "mock-model",
      choices: [{ message: { content: "mock vision result" } }],
      usage: { total_tokens: 12 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const result = await requestVisionCompletion({
      config: testConfig(),
      target: testTarget({ baseUrl: `http://127.0.0.1:${address.port}/v1` }),
      prompt: "What is shown?",
      images: [{
        dataUrl: `data:image/png;base64,${TINY_PNG.toString("base64")}`,
        label: "tiny image",
      }],
    });
    assert.equal(result.text, "mock vision result");
    assert.equal(result.model, "mock-model");
    assert.equal(authorization, "Bearer test-key");
    assert.equal(received?.model, "test-vision-model");
    const messages = received?.messages as Array<{ content: Array<{ type: string }> }>;
    assert.equal(messages[0]?.content.some((part) => part.type === "image_url"), true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("returns a useful provider error without exposing the API key", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "invalid credentials" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    await assert.rejects(
      requestVisionCompletion({
        config: testConfig(),
        target: testTarget({ baseUrl: `http://127.0.0.1:${address.port}/v1` }),
        prompt: "test",
        images: [{ dataUrl: `data:image/png;base64,${TINY_PNG.toString("base64")}` }],
      }),
      (error: Error) => {
        assert.match(error.message, /HTTP 401: invalid credentials/);
        assert.doesNotMatch(error.message, /test-key/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

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
    server.closeAllConnections();
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
