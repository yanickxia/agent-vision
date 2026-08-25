---
name: agent-vision
description: Analyze images, screenshots, diagrams, and videos you cannot see natively. Use for image questions, OCR, UI inspection, visual debugging, screen recordings, video summaries, and timeline analysis on text-only agents.
license: MIT
compatibility: Node.js 20+ for the CLI; the MCP server is optional.
---

# agent-vision

Use this skill when the user asks about an image or a video.

## Look first

If you can read images natively (for example the Read tool in Claude Code or
built-in multimodal input), look at the image yourself and answer directly.
Do not call any external tool for an image you can already see.

Videos are the exception: no agent can watch a video natively. Video analysis
always goes through the CLI below.

## Run the CLI

When you cannot see the input yourself (or it is a video), run the analysis
directly and read the plain-text output:

```bash
npx -y @yanickxia/agent-vision image "/absolute/path/to/error.png" --prompt "Read the error message and identify the likely cause."
npx -y @yanickxia/agent-vision video "/absolute/path/to/demo.mp4" --prompt "Summarize the UI flow in chronological order." --frames 8
```

If the package is installed locally, run `agent-vision image ...` instead of
`npx -y @yanickxia/agent-vision ...`.

## Calling rules

1. Pass the user's original question as `--prompt`. A focused question is
   better than a generic request for a description.
2. Prefer an absolute local path. HTTP(S) URLs are also supported. Images may
   additionally be supplied as a `data:image/...;base64,...` URI.
3. For videos, keep the default `--frames 8` unless the user needs a faster
   result or a denser timeline. The allowed range is 1–16.
4. If the result is uncertain, say so. Never invent visual details after a
   failed run.
5. Retry at most once for a transient API or timeout error. Configuration,
   unsupported-format, and missing-file errors require correction, not retries.

Configuration — multiple providers and models raced concurrently — is
described in `references/configuration.md`.
