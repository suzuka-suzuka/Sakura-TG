# SakuraTG

SakuraTG 是一个用途明确的 Telegram Bot：只做角色扮演对话和 NovelAI 绘图。

保留的能力：

- 多角色 RP：`/ai`、角色前缀、群内 `@Bot` 和可选的私聊自动回复。
- 模型原生图片输入：读取当前消息或被回复消息中的图片，直接沿当前模型路由提交。
- Redis 短期对话历史，以及清空、回退、篡改、列出和全局清理命令。
- 停止当前生成。
- NovelAI `/nai` / `绘图`、图生图、Vibe Transfer、V5/V4.5 能力分流、Anlas 保护和瞬时错误重试。
- RP 回复末尾的隐藏 `<draw>...</draw>` 自动配图；同一轮最多启动一次，默认生成一张，并可用命令查看上一次标签。
- 本地网页配置面板。

工程不包含模型工具调用、MCP、网页搜索、识图工具、群消息上下文、长期记忆、通用图片渠道、视频生成、模型列表和随机图源等功能。

## 启动

要求 Node.js 20+、pnpm 和 Redis。

```powershell
pnpm install
Copy-Item config/config.example.yaml config/config.yaml
pnpm start
```

默认配置面板地址为 <http://127.0.0.1:3457>。真实配置保存在 `config/config.yaml`，已被 Git 忽略。
模型 API Key 与 NovelAI Token 直接填写并保存到该配置文件，不依赖环境变量。

首次部署至少要配置：

1. `telegram.token`。
2. 文本模型的 `ai.providers` 和 `ai.routes`。
3. 至少一张 `ai.roleCards` 角色卡，以及一个引用它的 `ai.profiles` 运行配置。
4. 用于短期历史的 Redis。

私聊 Bot 发送 `/id` 可以取得自己的 Telegram 数字 ID，再填入 `telegram.masters`。

### Redis 自动启动

当 `redis.host` 是 `127.x.x.x`、`localhost` 或 `::1`，且目标端口尚未监听时，Bot 可以自动启动本机 Redis：

```yaml
redis:
  host: 127.0.0.1
  port: 6379
  password: ''
  execPath: 'D:\path\to\redis-server.exe'
  db: 1
```

`execPath` 既可填写 `redis-server.exe`，也可填写包含它的目录。远程 Redis 永远不会触发本地进程启动。

## 角色扮演

角色卡只保存名字和完整角色设定；角色运行配置从角色卡中选择名字，再单独设置触发前缀、模型路由、历史和 RP 配图：

```yaml
ai:
  defaultProfile: sakura
  roleCards:
    - name: sakura
      prompt: 你是小樱……
  profiles:
    - name: sakura
      prefixes: [小樱, 樱花]
      keepTriggerPrefix: true
      route: default
      history: true
      enableNaiPainting: true
      naiPrompt: ''
      enabled: true
```

配置面板中的“角色卡”用于新增和编辑名字、设定；“角色运行配置”里的角色卡字段是严格下拉选择，只能引用已经存在的角色卡，不能手动输入不存在的名字。旧版 `profiles[].prompt` 和更早的 `ai.roles` 会在启动时自动迁移到 `ai.roleCards`，已有角色设定不会丢失。

可用触发方式：

- `/ai 内容`
- `/ai 角色名: 内容`
- `角色前缀 + 内容`
- 群内 `@Bot 内容`
- 开启 `ai.privateAutoReply` 后，在私聊直接发送内容

Bot 每次启动都会自动向 Telegram 同步公开命令菜单，并把聊天菜单按钮设置为“命令”。同步成功后，在输入框键入 `/` 即可选择 `/ai`、`/nai`、`/lastdraw`、`/vibes`、`/stop`、`/forget`、`/aihelp` 和 `/id`。主人专用的 `/addvibe`、`/delvibe` 仍可手动输入，但不会展示给所有用户。

`keepTriggerPrefix` 可以按角色单独设置。开启时，前缀触发消息会完整送入模型，例如 `小樱你好` 仍然是 `小樱你好`；关闭时会移除命中的前缀，只发送 `你好`。这个选项不影响 `/ai 角色名:` 的角色选择语法，也不影响清空、回退、篡改和查看历史的前缀命令。

Bot 不会旁听、缓存或拼接群聊中的其他消息。用户明确回复一条 Telegram 消息时，该回复文字和图片可以作为当前轮输入。

### 流式输出

```yaml
ai:
  streaming:
    enabled: true
    privateIntervalMs: 800
    groupIntervalMs: 2000
```

回复会边生成边显示：

- 私聊使用 Telegram 消息草稿 `sendMessageDraft`（Bot API 9.3+），每 `privateIntervalMs` 刷新一次；生成结束后再发送正式消息。如果使用的自建 Bot API Server 不支持草稿，会自动改用编辑消息。
- 群聊先发送一条消息，之后每 `groupIntervalMs` 编辑一次；结束时把这条消息改成最终正文，超长部分另发新消息。编辑过于频繁触发 HTTP 429 时，会按 Telegram 返回的 `retry_after` 暂停。

生成过程中 `<draw>` 标签（包括还没写完的半截标签）不会显示。超过单条消息长度时，预览只显示末尾部分，最终正文仍完整分段发送。`#停止` 会立即中断模型的流式请求；停止或出错时，群聊里未完成的预览消息会被删除。

OpenAI 兼容端点如果忽略 `stream: true`、直接返回普通 JSON，会自动改用非流式请求重试一次。关闭 `enabled` 即恢复为生成完毕后一次性发送。

### 原生图片输入

图片只来自当前消息和它明确回复的消息，受 `ai.nativeVision.maxImages` 与 `maxBytes` 限制。图片不会写入 Redis 历史。

含图请求与文字请求使用同一条模型路由。当前图片会直接提交给路由中的目标；如果某个目标实际拒绝图片，请求会按原有路由顺序回退到下一个目标。Bot 不会预先维护模型识图能力开关，也不会调用识图工具或让另一个模型先把图片转换成文字。

## 短期历史

历史按“会话 + 用户 + 角色前缀”隔离，只保存 `{ role, parts: [{ text }] }` 形式的用户与模型文本。模型回复中的隐藏 `<draw>...</draw>` 会保留在 Redis 历史和后续模型上下文中，以维持画面连续性，但发送到 Telegram 时仍会从可见正文中隐藏；图片、工具交换和其他内部结构不会进入 Redis。

命令：

- `/forget [角色名|all]`
- `#清空对话<前缀>`
- `#撤回对话<前缀> [轮数]`
- `#回退对话<前缀> [轮数]`
- `#篡改对话<前缀> [序号] <新内容>`
- `#列出对话<前缀>` 或 `#查看对话<前缀>`
- `#清空全部对话`
- `#清空所有用户对话`（仅主人）

`#停止`、`#强制停止` 或 `/stop` 会请求停止当前生成。

### 历史压缩

```yaml
ai:
  chatHistoryLength: 20
  historySummary:
    enabled: true
    keepRounds: 10
```

历史超过 `chatHistoryLength` 轮后，Bot 会在回复发出后在后台压缩：保留最近 `keepRounds` 轮原文，把更早的轮次合并进这段对话的“前情提要”。压缩请求与正常对话使用同一条模型路由和**完全相同的系统提示词**（角色卡、RP 绘图规则和已有的前情提要），把要压缩的轮次原样作为历史，最后追加一条用户消息，即压缩指令 `historySummary.prompt`，告诉模型进行压缩。不填写时使用内置指令。

前情提要按“会话 + 用户 + 角色前缀”保存，有效期与历史相同，之后每一轮都放在系统提示词末尾的 `[前情提要]` 段落中。

- `#列出对话<前缀>` 会先显示前情提要。
- `#清空对话<前缀>`、`/forget`、`#清空全部对话` 会同时清除前情提要。
- `#撤回对话` 只删除最近的原文轮次，前情提要保留。
- 压缩失败时原文历史不会丢失，下一轮会再次尝试；历史最多暂存 `chatHistoryLength` 的两倍轮数。
- 压缩进行中如果用户发来新消息，这条消息会等压缩完成后再处理，避免读写同一段历史时互相覆盖。

关闭 `enabled` 后恢复旧行为：超过 `chatHistoryLength` 的最早轮次直接丢弃。

## NovelAI

```yaml
ai:
  novelAI:
    enabled: true
    model: nai-diffusion-5-full
    baseURL: https://image.novelai.net
    api: '请直接填写 NovelAI Token'
    checkV5Usage: true
    width: 832
    height: 1216
    scale: 7
    steps: 28
    sampler: k_euler_ancestral
    strength: 0.7
    noise: 0
    chatDrawWidth: 1216
    chatDrawHeight: 832
    chatDrawCount: 1
```

显式绘图、RP 自动配图、图生图和 Vibe 共用这一套 NovelAI 配置，不再选择图片渠道。RP 自动配图使用原生的 `width × height`，宽高必须是 64 的倍数；上例为横图 `1216 × 832`。`chatDrawCount` 大于 1 时不会提高单次请求的 `n_samples`，而是串行发起对应次数的单张请求；每张生成后立即开始发送，Telegram 发送未完成也不会阻塞下一张生成。

### 第三方站点

`baseURL` 可以填写兼容 NovelAI 接口的第三方站点，`api` 填该站点提供的 Key（以 `Authorization: Bearer` 发送，多行可轮询）。地址可以是站点根路径，如 `https://example.com/nai`，此时请求 `https://example.com/nai/ai/generate-image`；也可以直接粘贴以 `/ai/generate-image` 结尾的完整地址。请求体与官方完全一致，响应支持官方 ZIP、直接返回的图片，以及 JSON（base64、data URL 或图片链接，如 `{"images": [...]}`、`{"data": [{"b64_json": ...}]}`、`{"data": [{"url": ...}]}`）和 SSE `data:` 事件。

非 `novelai.net` 的地址会自动跳过 `checkV5Usage` 的官方账户用量查询，因为第三方站点使用自己的额度且通常没有 `/user/subscription` 接口。

绘图命令：

- `/nai 提示词`
- `绘图 [画风名] [横|方|竖] [角色站位] 提示词`
- 回复图片后使用上述命令可进行图生图
- `/addvibe 名称`、`/delvibe 名称`、`/vibes`
- `添加画风`、`删除画风`、`画风列表`

角色站位示例：

```text
绘图 梦幻可爱 横 [左: 1girl, blue hair] [@75,50: 1boy, black hair] cherry blossoms
```

NAI5 使用对应的 V5 参数与连续角色坐标；V4/V4.5 会按模型能力处理坐标。V5 不支持 Vibe Transfer 时会切到 V4.5，但每一次请求都必须符合单张、免费规格的纯文生图条件才允许安全回退，其他请求会在调用前停止，避免意外消耗 Anlas。网络中断、连接超时和 HTTP 429 会在真实请求层按 10、20、30 秒退避重试；参数、鉴权等确定性错误不会重试。

### RP 自动配图

给角色启用 `enableNaiPainting` 后，模型会被要求在回复末尾输出一个后端标签：

```text
角色回复正文。
<draw>1girl, waving, cherry blossoms, warm lighting</draw>
```

后端会在发送正文前移除标签，同时抽取第一个非空标签并异步提交给 NovelAI。固定 `naiPrompt` 只能追加到已有标签，不能单独触发绘图。同一聊天轮次最多调度一次图片。

多角色场景在同一个 `<draw>` 中分别填写角色提示词，方括号外只写公共场景、互动、构图和光照：

```text
<draw>2girls, cafe, night, table, sitting, talking, warm lighting, medium shot [左: 1girl, long black hair, green eyes, black dress, holding cup, looking at another] [@75,55: 1girl, silver hair, blue eyes, white blouse, leaning forward, looking at another]</draw>
```

位置支持 `左`、`右`、`左上`、`右下`、`中间` 等中文别名，也支持 `@25,55` 百分比坐标。旧的单行标签继续兼容。

提示词中的视觉描述必须二选一：要么使用标准 NovelAI/Danbooru tag，要么使用有明确主语和谓语的完整英文自然语言句子。不要使用 `silver-haired girl leaning across the table` 这类自然语言短语或残句；复杂互动可以写成完整句子，例如 `A silver-haired girl leans across the table while the black-haired girl watches her.`。

如果已经有 NovelAI/Danbooru 能识别的角色标签，只写一次角色标签，不再重复该角色固有的发色、发型、瞳色、体型、默认服装和默认配饰；只补当前画面发生变化的服装或配饰，以及姿势、动作、表情、视线和互动。例如使用 `hatsune miku (vocaloid)` 后，不再追加 `teal hair, twintails, teal eyes`。只有原创角色或找不到可靠角色标签时，才补足用于识别角色的稳定外观特征。

发送 `/lastdraw`、`查看绘图标签` 或 `上次绘图标签`，可以查看当前聊天中当前用户上一次 RP 自动配图的 AI 原始标签，以及实际提交给 NovelAI 的全局提示词和各角色提示词。记录与短期历史使用相同的 Redis 保存期限；群聊用户之间相互隔离。

## 验证

```powershell
pnpm test
pnpm web:build
```

测试使用本地 mock 和静态协议检查，不会发起真实的 NovelAI 付费生成，也不会消耗 Anlas。
