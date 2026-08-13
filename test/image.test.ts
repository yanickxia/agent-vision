import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadImage } from "../src/image.js";
import { TINY_PNG, testConfig } from "./helpers.js";

test("loads a local image and a data URI", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-vision-image-test-"));
  try {
    const filePath = path.join(directory, "tiny.png");
    await writeFile(filePath, TINY_PNG);
    const local = await loadImage(filePath, testConfig());
    assert.equal(local.mimeType, "image/png");
    assert.match(local.dataUrl, /^data:image\/png;base64,/);

    const data = await loadImage(
      `data:image/png;base64,${TINY_PNG.toString("base64")}`,
      testConfig(),
    );
    assert.equal(data.bytes, TINY_PNG.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads an HTTP image with private URLs explicitly enabled", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(TINY_PNG.length),
    });
    response.end(TINY_PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const image = await loadImage(
      `http://127.0.0.1:${address.port}/tiny.png`,
      testConfig({ allowPrivateUrls: true }),
    );
    assert.equal(image.mimeType, "image/png");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("blocks private remote source URLs by default", async () => {
  await assert.rejects(
    loadImage("http://127.0.0.1/image.png", testConfig({ allowPrivateUrls: false })),
    (error: Error & { code?: string }) => error.code === "PRIVATE_URL_BLOCKED",
  );
});
