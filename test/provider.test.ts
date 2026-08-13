import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { requestVisionCompletion } from "../src/provider.js";
import { TINY_PNG, testConfig } from "./helpers.js";

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
      config: testConfig({ baseUrl: `http://127.0.0.1:${address.port}/v1` }),
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
        config: testConfig({ baseUrl: `http://127.0.0.1:${address.port}/v1` }),
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
