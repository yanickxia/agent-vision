# agent-vision

一个小而直接的视觉 MCP Server + Agent Skill：让纯文本 Agent 通过一个
OpenAI-compatible 视觉模型理解图片和视频。

- 纯 Node.js / TypeScript，`npx` 自动下载运行
- MCP 工具：`analyze_image`、`analyze_video`
- Agent Skills 标准目录：`skills/agent-vision/`
- 图片：本地路径、HTTP(S) URL、Data URI
- 视频：本地路径或 URL，自动下载 npm 内的 ffmpeg 并均匀抽帧
- 单一 provider，无免费模型列表、fallback 竞速、watchdog 或透明代理

## 为什么做这个项目

参考项目各有优点，但组合起来偏重：

- [luma-mcp](https://github.com/JochenYang/luma-mcp)：Node.js、npx 和图片预处理体验好，但主要面向单图。
- [deepseek-vision-mcp](https://github.com/JunHua-ECJTU/deepseek-vision-mcp)：MCP 执行层与 Skill 决策层分离得很清楚，但依赖 Python，且本地视频受 provider 限制。
- [vision-tool](https://github.com/farhanic017/vision-tool)：支持视频抽帧，但包含大量 provider 探测、并行 fallback 和安装逻辑，并采用 GPL-3.0。
- [agent-vision-toolkit](https://github.com/Anionex/agent-vision-toolkit)：Skill 和任务工作流很强，但核心是多组 Python/Shell CLI，不是 MCP 视频服务。

`agent-vision` 只保留一条链路：**MCP/CLI → 图片或视频帧 → 你配置的视觉 API → 文本**。
本仓库是独立实现，没有复制 `vision-tool` 的 GPL 源码。

## 要求

- Node.js 20+
- 一个支持 `/chat/completions` 和 `image_url` 的 OpenAI-compatible 视觉模型

ffmpeg 由 `@ffmpeg-installer/ffmpeg` 按平台自动安装，无需另行安装。

## 配置

```bash
export AGENT_VISION_BASE_URL="https://your-endpoint.example/v1"
export AGENT_VISION_API_KEY="your-key"
export AGENT_VISION_MODEL="your-vision-model"
```

本地无鉴权端点可以不设置 API key。变量优先级：

| 设置 | 兼容回退 |
|---|---|
| `AGENT_VISION_API_KEY` | `VISION_API_KEY` → `OPENAI_API_KEY` |
| `AGENT_VISION_BASE_URL` | `VISION_BASE_URL` → `OPENAI_BASE_URL` |
| `AGENT_VISION_MODEL` | `VISION_MODEL` → `OPENAI_MODEL` |

可选变量：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `AGENT_VISION_MAX_TOKENS` | `4096` | 最大输出 tokens |
| `AGENT_VISION_TIMEOUT_MS` | `120000` | 下载和 API 超时 |
| `AGENT_VISION_MAX_IMAGE_MB` | `20` | 图片大小上限 |
| `AGENT_VISION_MAX_VIDEO_MB` | `200` | 视频大小上限 |
| `AGENT_VISION_HEADERS` | `{}` | 额外请求头 JSON |
| `AGENT_VISION_ALLOW_PRIVATE_URLS` | `false` | 允许私网图片/视频来源 URL |
| `AGENT_VISION_FFMPEG_PATH` | 自动发现 | 指定 ffmpeg 可执行文件；默认先用 PATH，再用 npm 内置版本 |

## MCP 安装

### npm（发布后推荐）

```json
{
  "mcpServers": {
    "agent-vision": {
      "command": "npx",
      "args": ["-y", "@yanickxia/agent-vision"],
      "env": {
        "AGENT_VISION_BASE_URL": "https://your-endpoint.example/v1",
        "AGENT_VISION_API_KEY": "your-key",
        "AGENT_VISION_MODEL": "your-vision-model"
      }
    }
  }
}
```

### 直接从 GitHub 运行

```json
{
  "mcpServers": {
    "agent-vision": {
      "command": "npx",
      "args": ["-y", "github:yanickxia/agent-vision"],
      "env": {
        "AGENT_VISION_BASE_URL": "https://your-endpoint.example/v1",
        "AGENT_VISION_API_KEY": "your-key",
        "AGENT_VISION_MODEL": "your-vision-model"
      }
    }
  }
}
```

Claude Desktop、Claude Code、Cursor、Cline 等使用上面的标准
`mcpServers` 格式。

### OpenCode

```jsonc
{
  "mcp": {
    "agent-vision": {
      "type": "local",
      "command": ["npx", "-y", "@yanickxia/agent-vision"],
      "enabled": true,
      "environment": {
        "AGENT_VISION_BASE_URL": "https://your-endpoint.example/v1",
        "AGENT_VISION_API_KEY": "your-key",
        "AGENT_VISION_MODEL": "your-vision-model"
      }
    }
  }
}
```

## Agent Skill

```bash
npx skills add yanickxia/agent-vision --skill agent-vision -g -y
```

也可以复制 `skills/agent-vision/` 到 Agent 的 skills 目录。Skill 负责告诉
Agent 何时调用图片/视频工具、如何传参和如何处理失败；MCP 负责实际读取文件、
抽帧和请求模型。

## CLI

```bash
npx -y @yanickxia/agent-vision image ./screenshot.png \
  --prompt "读取报错并给出可能原因"

npx -y @yanickxia/agent-vision video ./demo.mp4 \
  --prompt "按时间顺序总结 UI 操作" --frames 8

npx -y @yanickxia/agent-vision doctor
```

## MCP 工具

### `analyze_image`

```json
{
  "source": "/absolute/path/to/image.png",
  "prompt": "这个页面有哪些可用性问题？"
}
```

支持 JPEG、PNG、WebP、GIF、BMP。GIF 是否能体现动画取决于视觉模型；需要稳定的
时间线分析时请转为视频并使用 `analyze_video`。

### `analyze_video`

```json
{
  "source": "/absolute/path/to/video.mp4",
  "prompt": "概括操作流程和关键变化",
  "max_frames": 8
}
```

`max_frames` 范围 1–16，默认 8。实现会均匀抽取 JPEG 帧，并带时间点一起发给
模型。它不是逐帧转写，快速变化可能被漏掉。

## 隐私与安全

- 图片会发送到你配置的视觉 API。
- 视频不会整体发给模型；远程视频先下载到本地临时目录，然后只发送抽出的 JPEG 帧。
- 临时目录在成功或失败后都会删除。
- 用户提供的远程图片/视频 URL 默认拒绝 localhost、私网、链路本地和云元数据地址。
- stdio 模式不向 stdout 写日志，避免破坏 MCP 协议。

## 开发

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

## License

MIT。第三方依赖保留各自许可证，见 `NOTICE`。
