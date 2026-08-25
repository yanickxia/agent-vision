# agent-vision 自适应 Skill 与多模型并发竞速 设计文档

- 日期：2026-08-25
- 状态：设计已获用户批准，待实现

## 背景与目标

agent-vision 目前的形态：MCP server（`analyze_image` / `analyze_video`）+ CLI +
一个以「引导 Agent 调用 MCP 工具」为核心的 Skill，配置为单一 provider
（一组 `AGENT_VISION_BASE_URL` / `AGENT_VISION_API_KEY` / `AGENT_VISION_MODEL`）。

要解决的两个问题：

1. **Skill 引导错位**。`skills/agent-vision/SKILL.md` 明确写着
   "The MCP server is the execution layer; this skill explains when and how to
   call it"，frontmatter description 也写 "with the agent-vision MCP tools"。
   对本身具备视觉能力的 Agent（如 Claude Code）这是无谓绕路。
2. **单一模型**。无法配置多个视觉模型并发竞速、取最快结果。

目标：

- Skill 改为**能力自适应**：Agent 有原生视觉就直接自己看图作答；纯文本
  Agent 直接跑 CLI；视频一律走 CLI 抽帧。Skill 不再引导调用 MCP。
- 支持**多 provider 多模型**配置（XDG 路径下的 JSON 配置文件），并发请求
  所有 target，**第一个成功者胜出**，其余请求 abort。

## 1. Skill 重写

### 1.1 `skills/agent-vision/SKILL.md`

- frontmatter `description`：去掉 "with the agent-vision MCP tools"，改为
  能力无关的触发描述（image questions, OCR, UI inspection, visual
  debugging, screen recordings, video summaries, timeline analysis）。
- frontmatter `compatibility`：改为 "Node.js 20+ for the CLI; the MCP server
  is optional"。
- 正文结构（替换现有 "Choose the tool" / "Calling rules" / "npx fallback"）：
  1. **有原生视觉就直接看**：如果你能直接读取图片（如 Claude Code 的 Read
     工具、原生多模态能力），直接自己看图、自己作答，不调用任何外部工具。
     这是图片的默认路径。
  2. **视频一律走 CLI**：没有 Agent 能原生"观看"视频。需要抽帧分析时直接
     执行 CLI。
  3. **无视觉能力时的图片分析**：直接执行 CLI。
     ```bash
     npx -y @yanickxia/agent-vision image "/absolute/path/image.png" --prompt "用户问题"
     npx -y @yanickxia/agent-vision video "/absolute/path/demo.mp4" --prompt "用户问题" --frames 8
     ```
  4. **参数与失败处理规则**（保留现有内容）：prompt 传用户原始问题、聚焦
     优于泛化；视频默认 `max_frames=8`（范围 1–16）；瞬时错误最多重试一次；
     配置类/格式类/缺文件错误改正而非重试；结果不确定就明说，绝不编造。
- 删除 "The MCP server is the execution layer" 段落与全部 MCP-first 表述。
  MCP server 本身继续存在与发布，只是 Skill 不再引导 Agent 调用它。
- 配置指引指向 `references/configuration.md`（本地安装/非 npx 场景直接跑
  `agent-vision` 命令即可）。

### 1.2 `skills/agent-vision/references/configuration.md`

重写为以 `settings.json` 为主的配置说明（见 §2），环境变量作为回退方式
完整记录。

## 2. 配置

### 2.1 配置文件发现顺序

1. `AGENT_VISION_CONFIG` 指定的显式路径（文件不存在 → `CONFIG_ERROR`）
2. `$XDG_CONFIG_HOME/agent-vision/settings.json`；`XDG_CONFIG_HOME` 未设置时
   为 `~/.config/agent-vision/settings.json`（文件不存在 → 静默跳过）

两者皆无 → 完全走现有环境变量路径（老用户零感知，向下兼容）。

**不做**项目内自动发现（如 `./agent-vision.json`），避免 API key 被误提交
进仓库。

### 2.2 文件格式

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
      "models": ["gpt-4o"],
      "headers": { "x-extra": "value" }
    }
  ],
  "maxTokens": 4096,
  "timeoutMs": 120000,
  "headers": {},
  "maxImageMb": 20,
  "maxVideoMb": 200,
  "allowPrivateUrls": false,
  "ffmpegPath": "/usr/bin/ffmpeg"
}
```

- 顶层字段全部可选；`providers` 每项：
  - `baseUrl`（必填）、`models`（必填、非空数组）
  - `name`（可选；用于错误信息与 doctor 展示，如
    `dashscope/qwen-vl-max: HTTP 429`；缺省取 baseUrl 的 host）
  - `apiKey`（可选；本地无鉴权端点可省略）
  - `headers`（可选；合并到全局 `headers` 之上，同名键以 provider 级为准）
- 顶层旋钮与现有 env 变量一一对应：`maxTokens` / `timeoutMs` / `headers` /
  `maxImageMb` / `maxVideoMb` / `allowPrivateUrls` / `ffmpegPath`。
  `timeoutMs` 对每个并发请求独立生效。

### 2.3 展开规则

竞速 target 列表 = `providers` 扁平化：

```
targets = providers.flatMap(p =>
  p.models.map(m => ({
    label: `${p.name ?? host(p.baseUrl)}/${m}`,
    model: m,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    headers: { ...globalHeaders, ...p.headers },
  }))
)
```

§2.2 示例展开为 3 个 target（dashscope/qwen-vl-max、dashscope/qwen-vl-plus、
openai/gpt-4o），一次分析并发 3 个请求。

### 2.4 优先级

**文件里定义的字段优先 → 环境变量 → 内置默认值。**

- 文件存在且 `providers` 非空：使用文件的 providers，环境变量的
  `*_MODEL` / `*_BASE_URL` / `*_API_KEY` 被忽略（doctor 中提示来源）。
- 文件存在但未定义 `providers`：providers 回退到 env 单模型路径，其余
  顶层旋钮仍按「文件优先」合并。
- 选择"文件优先"而非"env 优先"的原因：环境中易残留 `OPENAI_MODEL` 之类的
  别名变量，若 env 优先会导致配置文件永远不生效。

### 2.5 校验与错误

- JSON 解析失败、`providers` 存在但为空数组、某 provider 缺 `baseUrl`、
  `models` 缺失或为空、字段类型错误 → `CONFIG_ERROR`，错误信息包含
  配置文件路径与具体字段名。
- 含 `apiKey` 的文件建议 `chmod 600`（写入文档）。

## 3. 竞速执行（`src/provider.ts`）

- 新增 `raceVisionCompletions({ config, prompt, images })`：
  - `config.targets` 长度为 1 → 直接调用 `requestVisionCompletion`，
    行为与现状逐字节一致（含错误消息格式）。
  - 长度 > 1 → 对每个 target 并发调用 `requestVisionCompletion`（每个
    target 使用自己的 baseUrl / apiKey / headers / model）。
- **第一个成功者胜出**（`Promise.any` 语义，非"第一个 settle"）：A 2 秒
  失败、B 30 秒成功 → 结果用 B。
- **胜出后 abort 其余请求**（省 token）：`requestVisionCompletion` 增加
  可选外部 `AbortSignal` 参数，与超时 signal 合并生效。
- **全部失败** → 抛出聚合 `VisionError`（code `API_ERROR`），每个 target
  一行：`label: 错误摘要`。
- 视频抽帧 / 图片读取在竞速**之前**完成一次（在 `analyze.ts` 中，现状
  已如此），不重复执行 ffmpeg。

## 4. 接线

- `src/config.ts`：
  - `VisionConfig` 增加 `targets: ModelTarget[]` 与 `configFile?: string`
    （doctor 展示用）。env 回退路径产生单个 target，`label` 为模型名
    （即 `requireModel` 的报错与聚合错误中的展示与现状一致）。
  - `loadConfig(env, readFile?)`：`readFile` 为可注入的文件读取函数
    （默认真实 fs），便于测试。
  - `requireModel` 改为校验 `targets` 非空。
- `src/analyze.ts`：`analyzeImage` / `analyzeVideo` 签名不变，内部改调
  `raceVisionCompletions`。
- `src/server.ts`：**零改动**。
- `src/cli.ts` `doctor`：输出配置文件路径（找到/未找到）、逐条 target
  （label、baseUrl、key 状态、字段来源 file/env/default）、ffmpeg 状态；
  无 target 或 ffmpeg 不可用 → exit code 1。
- 输出保持纯文本分析结果，不附加"哪个模型胜出"（对 Agent 消费方无噪音）。

## 5. 文档更新

- `README.md`：
  - 定位句「单一 provider，无免费模型列表、fallback 竞速、watchdog 或
    透明代理」改为「支持多 provider 多模型并发竞速，谁先返回用谁」。
  - 配置章节：`settings.json` 为主，env 为回退；MCP 安装示例简化为
    `npx -y @yanickxia/agent-vision`（无需 env 块）。
  - 明示竞速成本：图片/视频帧会发给**所有**配置的模型（N 倍上传与
    token 费用）。
- `skills/agent-vision/references/configuration.md`：见 §1.2。

## 6. 测试计划

- `test/config.test.ts`：
  - 文件发现：`AGENT_VISION_CONFIG` 显式路径、XDG 默认路径、无文件时
    env 回退。
  - providers 解析与扁平化展开、`name` 缺省取 host、provider headers
    合并。
  - 校验错误：坏 JSON、空 `providers`、缺 `baseUrl`、空 `models`。
  - 优先级：文件 > env；文件有 providers 时忽略 env 模型；文件只有旋钮
    时 env 模型仍生效。
  - 向下兼容：无文件时现有 env 用例全部保持。
- `test/provider.test.ts`：
  - 竞速胜出：mock fetch 不同延迟，断言取最快成功者。
  - 失败让位：先失败的后成功的 target 作为结果。
  - 全失败聚合错误包含每个 target 一行。
  - 败者被 abort（断言 abort signal 触发）。
  - 单 target：行为与错误消息格式与现状一致。
- `test/image.test.ts` / `test/video.test.ts` / `test/mcp.test.ts`：
  现有用例不动，应全绿；新增一条多 target 走竞速路径的集成用例。

## 7. 非目标

- 不做项目级配置文件自动发现。
- 不做 per-target 的 `timeoutMs` / `maxTokens` 覆盖（全局统一）。
- 不做"失败后顺序 fallback"——并发竞速本身已覆盖该场景。
- Skill 不再提及 MCP，但 MCP server 持续维护与发布。
- 输出不附加胜出模型信息。

## 8. 风险与代价

- 竞速意味着每次分析产生 N 份上传与 N 份推理费用（胜者之外的请求虽被
  abort，仍可能已产生部分费用）。已在 README 中明示。
- 配置文件含明文 API key，依赖用户自觉 `chmod 600`（文档提示，不做强制）。
