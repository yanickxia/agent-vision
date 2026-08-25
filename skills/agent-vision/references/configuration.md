# Configuration

agent-vision reads its configuration from a JSON settings file. Environment
variables still work as a fallback.

## Settings file

The first location that exists wins:

1. `$AGENT_VISION_CONFIG` — an explicit file path (an error if it is missing)
2. `$XDG_CONFIG_HOME/agent-vision/settings.json`
   (default: `~/.config/agent-vision/settings.json`)

```json
{
  "providers": [
    {
      "name": "dashscope",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKey": "sk-...",
      "models": ["qwen-vl-max", "qwen-vl-plus"]
    },
    {
      "name": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "models": ["gpt-4o"]
    }
  ],
  "maxTokens": 4096,
  "timeoutMs": 120000
}
```

- Every provider × model combination is a target. With several targets, all
  of them are requested **concurrently** and the first successful answer
  wins; the remaining requests are aborted. Note the cost: N targets means
  up to N paid completions per analysis.
- `name` is optional and only used in error messages; it defaults to the
  baseUrl host.
- `apiKey` is optional per provider (for local endpoints without auth) and
  falls back to the environment key.
- `headers` per provider merges over the top-level `headers`.
- Top-level knobs (all optional): `maxTokens`, `timeoutMs`, `headers`,
  `maxImageMb`, `maxVideoMb`, `allowPrivateUrls`, `ffmpegPath`.
- Fields defined in the file take precedence over environment variables.
- The file may contain API keys: keep it out of version control and run
  `chmod 600` on it.

## Environment variables (fallback)

Required when no settings file is used:

```bash
export AGENT_VISION_BASE_URL="https://your-openai-compatible-endpoint/v1"
export AGENT_VISION_API_KEY="your-key"
export AGENT_VISION_MODEL="your-vision-model"
```

`AGENT_VISION_API_KEY` may be omitted for a trusted local endpoint that does
not require authentication. The server also recognizes `VISION_*` and
`OPENAI_*` aliases.

Optional variables:

- `AGENT_VISION_MAX_TOKENS` (default `4096`)
- `AGENT_VISION_TIMEOUT_MS` (default `120000`)
- `AGENT_VISION_MAX_IMAGE_MB` (default `20`)
- `AGENT_VISION_MAX_VIDEO_MB` (default `200`)
- `AGENT_VISION_HEADERS` (JSON object of extra HTTP headers)
- `AGENT_VISION_ALLOW_PRIVATE_URLS=true` (allow private image/video source URLs)
- `AGENT_VISION_FFMPEG_PATH` (override ffmpeg; otherwise PATH, then bundled binary)

The configured API endpoint itself may be private; the private-URL guard only
applies to user-provided image and video source URLs.
