import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureFfmpeg } from "../src/video.js";

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await ensureFfmpeg();
    return true;
  } catch {
    return false;
  }
}

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
    assert.equal(code, (await ffmpegAvailable()) ? 0 : 1);
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
      AGENT_VISION_API_KEY: "",
      VISION_API_KEY: "",
      OPENAI_API_KEY: "",
    });
    assert.equal(code, (await ffmpegAvailable()) ? 0 : 1);
    assert.match(stdout, /config file: .*settings\.json/);
    assert.match(stdout, /dashscope\/a\s+https:\/\/dash\.example\/v1\s+key: not configured/);
    assert.match(stdout, /dashscope\/b/);
    assert.doesNotMatch(stdout, /env-model/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
