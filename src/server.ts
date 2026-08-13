import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzeImage, analyzeVideo } from "./analyze.js";
import { errorMessage } from "./errors.js";

export const SERVER_VERSION = "0.1.0";

function failure(error: unknown) {
  return {
    content: [{ type: "text" as const, text: errorMessage(error) }],
    isError: true,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "agent-vision",
    version: SERVER_VERSION,
  });

  server.registerTool(
    "analyze_image",
    {
      title: "Analyze image",
      description:
        "Analyze an image from a local path, HTTP(S) URL, or base64 data URI. Use this for screenshots, UI, OCR, diagrams, photos, and visual debugging.",
      inputSchema: z.object({
        source: z.string().min(1).describe("Local path, HTTP(S) URL, or data:image/... URI"),
        prompt: z.string().optional().describe("The user's specific question about the image"),
      }),
    },
    async ({ source, prompt }) => {
      try {
        const result = await analyzeImage({ source, ...(prompt ? { prompt } : {}) });
        return { content: [{ type: "text", text: result.text }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "analyze_video",
    {
      title: "Analyze video",
      description:
        "Analyze a local or remote video by extracting evenly spaced keyframes. Use this for screen recordings, UI flows, demos, and event summaries.",
      inputSchema: z.object({
        source: z.string().min(1).describe("Local path or HTTP(S) URL"),
        prompt: z.string().optional().describe("The user's specific question about the video"),
        max_frames: z.number().int().min(1).max(16).optional().describe("Number of frames to sample; default 8"),
      }),
    },
    async ({ source, prompt, max_frames }) => {
      try {
        const result = await analyzeVideo({
          source,
          ...(prompt ? { prompt } : {}),
          ...(max_frames ? { maxFrames: max_frames } : {}),
        });
        return { content: [{ type: "text", text: result.text }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
