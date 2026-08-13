---
name: agent-vision
description: Analyze images, screenshots, diagrams, and videos with the agent-vision MCP tools. Use for image questions, OCR, UI inspection, visual debugging, screen recordings, video summaries, and timeline analysis.
license: MIT
compatibility: Requires the agent-vision MCP server or Node.js 20+ for the npx fallback, plus an OpenAI-compatible vision API.
---

# agent-vision

Use this skill when the user asks you to inspect an image or video. The MCP
server is the execution layer; this skill explains when and how to call it.

## Choose the tool

| Input | Tool |
|---|---|
| Screenshot, photo, diagram, UI, scanned text | `analyze_image` |
| Screen recording, demo, clip, animation timeline | `analyze_video` |

Do not call a vision tool for a text-only task.

## Calling rules

1. Pass the user's original question as `prompt`. A focused question is better
   than a generic request for a description.
2. Prefer an absolute local path. HTTP(S) URLs are also supported. Images may
   additionally be supplied as a `data:image/...;base64,...` URI.
3. For videos, keep the default `max_frames=8` unless the user needs a faster
   result or a denser timeline. The allowed range is 1–16.
4. If the result is uncertain, say so. Never invent visual details after a
   failed tool call.
5. Retry at most once for a transient API or timeout error. Configuration,
   unsupported-format, and missing-file errors require correction, not retries.

## Examples

```json
analyze_image({
  "source": "/absolute/path/to/error.png",
  "prompt": "Read the error message and identify the likely cause."
})
```

```json
analyze_video({
  "source": "/absolute/path/to/demo.mp4",
  "prompt": "Summarize the UI flow in chronological order.",
  "max_frames": 8
})
```

## npx fallback

If the MCP tools are not available but shell execution is allowed, run:

```bash
npx -y @yanickxia/agent-vision image "/absolute/path/to/image.png" --prompt "user question"
npx -y @yanickxia/agent-vision video "/absolute/path/to/video.mp4" --prompt "user question" --frames 8
```

Before the npm package is available, replace the package name with
`github:yanickxia/agent-vision`.

Configuration details are in `references/configuration.md`.
