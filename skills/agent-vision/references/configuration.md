# Configuration

Required for normal use:

```bash
export AGENT_VISION_BASE_URL="https://your-openai-compatible-endpoint/v1"
export AGENT_VISION_API_KEY="your-key"
export AGENT_VISION_MODEL="your-vision-model"
```

`AGENT_VISION_API_KEY` may be omitted for a trusted local endpoint that does
not require authentication. The server also recognizes `VISION_*` and
`OPENAI_*` aliases.

Useful optional variables:

- `AGENT_VISION_MAX_TOKENS` (default `4096`)
- `AGENT_VISION_TIMEOUT_MS` (default `120000`)
- `AGENT_VISION_MAX_IMAGE_MB` (default `20`)
- `AGENT_VISION_MAX_VIDEO_MB` (default `200`)
- `AGENT_VISION_HEADERS` (JSON object of extra HTTP headers)
- `AGENT_VISION_ALLOW_PRIVATE_URLS=true` (allow private image/video source URLs)
- `AGENT_VISION_FFMPEG_PATH` (override ffmpeg; otherwise PATH, then bundled binary)

The configured API endpoint itself may be private; the private-URL guard only
applies to user-provided image and video source URLs.
