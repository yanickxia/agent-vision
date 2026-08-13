import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureFfmpeg, extractVideoFrames } from "../src/video.js";
import { testConfig } from "./helpers.js";

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

test("extracts evenly spaced frames and removes its working directory", async (t) => {
  let ffmpegPath: string;
  try {
    ffmpegPath = await ensureFfmpeg();
  } catch {
    t.skip("ffmpeg-static has no binary for this platform");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "agent-vision-video-test-"));
  try {
    const videoPath = path.join(root, "sample.mp4");
    await run(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x120:rate=4",
      "-t",
      "2",
      "-c:v",
      "mpeg4",
      "-y",
      videoPath,
    ]);
    const frames = await extractVideoFrames({
      source: videoPath,
      maxFrames: 4,
      config: testConfig(),
      tempRoot: root,
    });
    assert.equal(frames.length, 4);
    assert(frames.every((frame) => frame.dataUrl.startsWith("data:image/jpeg;base64,")));
    assert.deepEqual(
      frames.map((frame) => Number(frame.timestampSeconds.toFixed(2))),
      [0.25, 0.75, 1.25, 1.75],
    );
    assert.deepEqual((await readdir(root)).sort(), ["sample.mp4"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
