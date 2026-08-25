#!/usr/bin/env node

import { analyzeImage, analyzeVideo } from "./analyze.js";
import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { SERVER_VERSION, startStdioServer } from "./server.js";
import { ensureFfmpeg } from "./video.js";

const HELP = `agent-vision ${SERVER_VERSION}

Usage:
  agent-vision                         Start the MCP stdio server
  agent-vision image <source> [options]
  agent-vision video <source> [options]
  agent-vision doctor

Options:
  -p, --prompt <text>                  Question or focus for the analysis
  --frames <1-16>                      Video frames to sample (default: 8)
  -h, --help                           Show help
  -v, --version                        Show version
`;

function option(args: string[], long: string, short?: string): string | undefined {
  const prefix = `${long}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.findIndex((arg) => arg === long || (short && arg === short));
  return index >= 0 ? args[index + 1] : undefined;
}

async function runCli(args: string[]): Promise<void> {
  const command = args[0];
  if (!command) {
    await startStdioServer();
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
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
  if (command !== "image" && command !== "video") {
    throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
  const source = args[1];
  if (!source || source.startsWith("-")) {
    throw new Error(`${command} requires a source path or URL`);
  }
  const prompt = option(args.slice(2), "--prompt", "-p");
  if (command === "image") {
    const result = await analyzeImage({ source, ...(prompt ? { prompt } : {}) });
    process.stdout.write(`${result.text}\n`);
    return;
  }
  const framesRaw = option(args.slice(2), "--frames");
  const maxFrames = framesRaw ? Number(framesRaw) : undefined;
  const result = await analyzeVideo({
    source,
    ...(prompt ? { prompt } : {}),
    ...(maxFrames !== undefined ? { maxFrames } : {}),
  });
  process.stdout.write(`${result.text}\n`);
}

runCli(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`agent-vision: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
