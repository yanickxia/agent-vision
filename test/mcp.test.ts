import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { TINY_PNG } from "./helpers.js";

test("MCP stdio lists both tools and calls analyze_image", async () => {
  const api = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain request body.
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "mock-model",
      choices: [{ message: { content: "image call succeeded" } }],
    }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert(address && typeof address === "object");

  const directory = await mkdtemp(path.join(tmpdir(), "agent-vision-mcp-test-"));
  const imagePath = path.join(directory, "tiny.png");
  await writeFile(imagePath, TINY_PNG);
  const child = spawn(process.execPath, [path.resolve("dist/cli.js")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: directory,
      AGENT_VISION_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AGENT_VISION_API_KEY: "mock-key",
      AGENT_VISION_MODEL: "mock-model",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = message.id;
    if (typeof id === "number") {
      pending.get(id)?.(message);
      pending.delete(id);
    }
  });
  function send(id: number, method: string, params: Record<string, unknown> = {}) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 10_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  try {
    const initialized = await send(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agent-vision-test", version: "1.0.0" },
    });
    assert(initialized.result);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listed = await send(2, "tools/list");
    const result = listed.result as { tools: Array<{ name: string }> };
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["analyze_image", "analyze_video"]);

    const called = await send(3, "tools/call", {
      name: "analyze_image",
      arguments: { source: imagePath, prompt: "test" },
    });
    const callResult = called.result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(callResult.isError, undefined);
    assert.equal(callResult.content[0]?.text, "image call succeeded");
  } finally {
    child.stdin.end();
    child.kill();
    lines.close();
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
