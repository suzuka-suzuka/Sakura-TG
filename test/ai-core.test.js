import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import Config, { migrateLegacyAiConfig } from "../src/config.js";
import { AISchema } from "../src/ai/configSchema.js";
import {
  DEFAULT_CHAT_DRAW_PROMPT,
  dispatchTaggedChatResponse,
  parseChatDrawTags,
} from "../src/ai/chatDrawTags.js";
import {
  formatLastChatDraw,
  getLastChatDrawKey,
  loadLastChatDraw,
  saveLastChatDraw,
} from "../src/ai/chatDrawHistory.js";
import {
  consumeConversationPrefix,
  parseChineseConversationCommand,
  rollbackConversationHistory,
  tamperConversationHistory,
} from "../src/ai/conversationCommands.js";
import {
  sanitizeConversationHistory,
  trimConversationHistoryByRounds,
} from "../src/ai/conversationHistory.js";
import { resolveConfigValue } from "../src/ai/configValue.js";
import { getAI } from "../src/ai/getAI.js";
import {
  buildProfileTriggerQuery,
  matchProfilePrefix,
} from "../src/ai/profileTriggers.js";
import { resolveRoleCardPrompt } from "../src/ai/roleCards.js";
import {
  createRouteExecutionPlan,
  orderScheduledItems,
  resetRoutingCursors,
  resolveGenerationSettings,
} from "../src/ai/providerRouter.js";
import {
  renderTelegramHtml,
  renderTelegramHtmlChunks,
} from "../src/ai/telegramHtml.js";
import { sendAiText } from "../src/ai/telegramAdapter.js";
import { modules } from "../src/modules/index.js";
import {
  syncTelegramCommandMenu,
  TELEGRAM_COMMAND_MENU,
} from "../src/telegramCommands.js";

function withConfig(config, task) {
  const previous = Config.config;
  Config.config = config;
  return Promise.resolve()
    .then(task)
    .finally(() => {
      Config.config = previous;
    });
}

async function startOpenAIMock(t, handler) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : null;
    await handler({ request, response, body });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}/v1`;
}

function chatConfig({ baseURL = "http://127.0.0.1:1/v1" } = {}) {
  return {
    telegram: { localApiServer: false },
    ai: AISchema.parse({
      providers: [
        {
          id: "mock",
          protocol: "openai",
          baseURL,
          credentials: [
            {
              id: "primary",
              apiKey: "test-key",
              enabled: true,
              priority: 0,
              weight: 1,
            },
          ],
        },
      ],
      routes: [
        {
          id: "roleplay",
          strategy: "priority",
          retryDelayMs: 0,
          maxAttempts: 3,
          targets: [
            {
              id: "primary",
              provider: "mock",
              model: "primary-model",
              priority: 10,
            },
            {
              id: "fallback",
              provider: "mock",
              model: "fallback-model",
              priority: 0,
            },
          ],
        },
      ],
    }),
  };
}

test("AI 默认配置只包含 RP、原生图片输入、短期历史和 NovelAI", () => {
  const config = AISchema.parse({});
  assert.equal(config.enabled, true);
  assert.equal(config.nativeVision.maxImages, 4);
  assert.equal(config.nativeVision.maxBytes, 20 * 1024 * 1024);
  assert.deepEqual(config.roleCards, []);
  assert.equal(config.novelAI.chatDrawWidth, 1216);
  assert.equal(config.novelAI.chatDrawHeight, 832);
  assert.equal(config.novelAI.chatDrawCount, 1);
  assert.equal(config.novelAI.model, "nai-diffusion-5-full");
  assert.equal(
    Object.hasOwn(config.novelAI, "chatDrawAspectRatio"),
    false
  );
  assert.equal(Object.hasOwn(config.novelAI, "defaultChannel"), false);
  assert.equal(Object.hasOwn(config.novelAI, "channels"), false);

  assert.throws(
    () =>
      AISchema.parse({
        novelAI: { chatDrawWidth: 1200, chatDrawHeight: 832 },
      }),
    /尺寸必须是 64 的倍数/
  );

  for (const removed of [
    "roles",
    "toolsEnabled",
    "toolGroups",
    "toolsRoute",
    "groupContextLength",
    "groupMessageMaxCount",
    "groupMessageTtlSeconds",
    "maxToolCalls",
    "trustAICommand",
    "image",
    "video",
    "mcp",
    "memory",
  ]) {
    assert.equal(Object.hasOwn(config, removed), false, removed);
  }
});

test("旧配置迁移保留角色卡、NAI 配置和图片上限并删除废弃字段", () => {
  const migrated = migrateLegacyAiConfig({
    loliImage: { cacheTtl: 600 },
    ai: {
      roles: [{ name: "sakura", prompt: "完整角色设定" }],
      profiles: [
        {
          name: "sakura",
          prompt: "",
          promptAddons: ["CurrentTime"],
          groupContext: true,
          toolGroup: "everything",
          naiChannel: "nai-main",
        },
      ],
      routes: [
        {
          id: "default",
          targets: [
            {
              id: "vision",
              supportsImages: false,
              nativeWebSearch: true,
            },
          ],
        },
      ],
      toolsEnabled: true,
      toolGroups: [{ name: "everything", tools: ["Memory"] }],
      toolsRoute: "default",
      groupContextLength: 20,
      image: {
        enabled: true,
        defaultChannel: "unrelated-generic-image",
        chatDrawPrompt: "draw prompt",
        chatDrawAspectRatio: "3:2",
        chatDrawCount: 1,
        maxInputImages: 3,
        maxInputBytes: 123456,
        channels: {
          novelai: [
            {
              name: "nai-main",
              model: "nai-diffusion-5-full",
              api: "secret-placeholder",
            },
          ],
        },
      },
      video: {},
      mcp: {},
      memory: {},
    },
  });

  assert.equal(Object.hasOwn(migrated, "loliImage"), false);
  assert.deepEqual(migrated.ai.roleCards, [
    { name: "sakura", prompt: "完整角色设定" },
  ]);
  assert.equal(Object.hasOwn(migrated.ai.profiles[0], "prompt"), false);
  assert.deepEqual(migrated.ai.nativeVision, {
    maxImages: 3,
    maxBytes: 123456,
  });
  assert.equal(migrated.ai.novelAI.chatDrawWidth, 1216);
  assert.equal(migrated.ai.novelAI.chatDrawHeight, 832);
  assert.equal(
    Object.hasOwn(migrated.ai.novelAI, "chatDrawAspectRatio"),
    false
  );
  assert.equal(migrated.ai.novelAI.api, "secret-placeholder");
  assert.equal(Object.hasOwn(migrated.ai.novelAI, "defaultChannel"), false);
  assert.equal(Object.hasOwn(migrated.ai.novelAI, "channels"), false);
  assert.equal(
    Object.hasOwn(migrated.ai.routes[0].targets[0], "supportsImages"),
    false
  );
  assert.equal(
    Object.hasOwn(migrated.ai.routes[0].targets[0], "nativeWebSearch"),
    false
  );
  for (const removed of [
    "roles",
    "toolsEnabled",
    "toolGroups",
    "toolsRoute",
    "image",
    "video",
    "mcp",
    "memory",
  ]) {
    assert.equal(Object.hasOwn(migrated.ai, removed), false, removed);
  }
  for (const removed of [
    "prompt",
    "promptAddons",
    "groupContext",
    "toolGroup",
    "naiChannel",
  ]) {
    assert.equal(Object.hasOwn(migrated.ai.profiles[0], removed), false, removed);
  }
});

test("角色设定迁移以独立角色卡为准并保持幂等", () => {
  const migrated = migrateLegacyAiConfig({
    ai: {
      roleCards: [{ name: "existing", prompt: "独立角色卡设定" }],
      roles: [
        { name: "existing", prompt: "更早的角色设定" },
        { name: "legacy-match", prompt: "旧 roles 匹配设定" },
        { name: "legacy-only", prompt: "仅存在于旧 roles 的设定" },
      ],
      profiles: [
        { name: "existing", prompt: "旧 profile 设定" },
        { name: "profile-only", prompt: "仅存在于 profile 的设定" },
        { name: "legacy-match", prompt: "" },
      ],
    },
  });

  assert.deepEqual(migrated.ai.roleCards, [
    { name: "existing", prompt: "独立角色卡设定" },
    { name: "profile-only", prompt: "仅存在于 profile 的设定" },
    { name: "legacy-match", prompt: "旧 roles 匹配设定" },
    { name: "legacy-only", prompt: "仅存在于旧 roles 的设定" },
  ]);
  assert.equal(
    migrated.ai.profiles.every(
      (profile) => !Object.hasOwn(profile, "prompt")
    ),
    true
  );
  assert.deepEqual(migrateLegacyAiConfig(migrated), migrated);
});

test("角色运行配置只能引用唯一且已存在的角色卡", () => {
  const shared = {
    providers: [
      {
        id: "provider",
        credentials: [{ id: "credential", apiKey: "test-key" }],
      },
    ],
    routes: [
      {
        id: "route",
        targets: [
          { id: "target", provider: "provider", model: "test-model" },
        ],
      },
    ],
  };
  const currentFormatWithMissingCard = migrateLegacyAiConfig({
    ai: {
      roleCards: [{ name: "known", prompt: "known prompt" }],
      profiles: [{ name: "missing", route: "route" }],
    },
  });
  assert.deepEqual(currentFormatWithMissingCard.ai.roleCards, [
    { name: "known", prompt: "known prompt" },
  ]);

  const missing = AISchema.safeParse({
    ...shared,
    ...currentFormatWithMissingCard.ai,
  });
  assert.equal(missing.success, false);
  assert.equal(
    missing.error.issues.some(
      (issue) =>
        issue.path.join(".") === "profiles.0.name" &&
        /角色卡.*不存在/.test(issue.message)
    ),
    true
  );

  const duplicated = AISchema.safeParse({
    roleCards: [
      { name: "same", prompt: "first" },
      { name: " same ", prompt: "second" },
    ],
  });
  assert.equal(duplicated.success, false);
  assert.equal(
    duplicated.error.issues.some(
      (issue) => issue.path.join(".") === "roleCards.1.name"
    ),
    true
  );
});

test("运行时按角色运行配置名称读取独立角色卡设定", () => {
  const roleCards = [
    { name: "小叶", prompt: "  你是小叶。\n保持自然的角色扮演。  " },
    { name: "小樱", prompt: "你是小樱。" },
  ];
  assert.equal(
    resolveRoleCardPrompt({ name: "小叶" }, roleCards),
    "你是小叶。\n保持自然的角色扮演。"
  );
  assert.equal(resolveRoleCardPrompt({ name: "不存在" }, roleCards), "");
});

test("旧 RP 自动比例按默认 NovelAI 渠道迁移为原生宽高", () => {
  const migrated = migrateLegacyAiConfig({
    ai: {
      novelAI: {
        defaultChannel: "square",
        chatDrawAspectRatio: "auto",
        channels: [
          { name: "portrait", width: 832, height: 1216, api: "portrait" },
          { name: "square", width: 1024, height: 1024, api: "square" },
        ],
      },
    },
  });

  assert.equal(migrated.ai.novelAI.chatDrawWidth, 1024);
  assert.equal(migrated.ai.novelAI.chatDrawHeight, 1024);
  assert.equal(migrated.ai.novelAI.width, 1024);
  assert.equal(migrated.ai.novelAI.height, 1024);
  assert.equal(migrated.ai.novelAI.api, "square");
  assert.equal(
    Object.hasOwn(migrated.ai.novelAI, "chatDrawAspectRatio"),
    false
  );
});

test("旧 RP 绘图提示词补充角色标签去重规则且保留自定义内容", () => {
  const original = "保留我的自定义 RP 绘图要求。";
  const migrated = migrateLegacyAiConfig({
    ai: { novelAI: { chatDrawPrompt: original } },
  });
  assert.equal(migrated.ai.novelAI.chatDrawPrompt.startsWith(original), true);
  assert.match(
    migrated.ai.novelAI.chatDrawPrompt,
    /recognized English Danbooru\/NovelAI character tag/
  );
  assert.match(
    migrated.ai.novelAI.chatDrawPrompt,
    /Do not repeat inherent appearance traits/
  );
  assert.equal(
    migrateLegacyAiConfig(migrated).ai.novelAI.chatDrawPrompt,
    migrated.ai.novelAI.chatDrawPrompt
  );
  assert.equal(
    migrateLegacyAiConfig({
      ai: { novelAI: { chatDrawPrompt: "" } },
    }).ai.novelAI.chatDrawPrompt,
    ""
  );
});

test("Telegram HTML 渲染层仍能安全转义 draw 标签", () => {
  const rendered = renderTelegramHtml(
    [
      "# 标题",
      "",
      "**粗体**、*斜体*、~~删除线~~",
      "[链接](https://example.com/a_(b))",
      "`const foo_bar = 1;`",
    ].join("\n")
  );
  assert.match(rendered, /^<b>标题<\/b>/);
  assert.match(rendered, /<b>粗体<\/b>、<i>斜体<\/i>、<s>删除线<\/s>/);
  assert.match(rendered, /<a href="https:\/\/example\.com\/a_\(b\)">链接<\/a>/);
  assert.match(rendered, /<code>const foo_bar = 1;<\/code>/);
  assert.equal(
    renderTelegramHtml("<draw>1girl, smile</draw>"),
    "&lt;draw&gt;1girl, smile&lt;/draw&gt;"
  );
  const chunks = renderTelegramHtmlChunks("**粗体** ".repeat(1000), 500);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.every((chunk) => chunk.html.length <= 500), true);
});

test("AI 文本优先用 Telegram HTML，实体错误时降级纯文本", async () => {
  const calls = [];
  const context = {
    chat: { id: 1, type: "private" },
    reply: async (...args) => {
      calls.push(args);
      if (calls.length === 1) {
        const error = new Error("Bad Request: can't parse entities");
        error.description = "Bad Request: can't parse entities";
        throw error;
      }
      return { message_id: 2, text: args[0] };
    },
  };
  await sendAiText(context, "**加粗**");
  assert.equal(calls[0][0], "<b>加粗</b>");
  assert.equal(calls[0][1].parse_mode, "HTML");
  assert.equal(calls[1][0], "**加粗**");
  assert.equal(calls[1][1], undefined);
});

test("RP 绘图标签从正文隐藏、支持多角色，并且同一轮最多绘制一次", async () => {
  assert.match(DEFAULT_CHAT_DRAW_PROMPT, /hidden backend tag, no image-tool call/);
  assert.match(DEFAULT_CHAT_DRAW_PROMPT, /closing <\/draw> tag must be the final characters/);
  assert.match(DEFAULT_CHAT_DRAW_PROMPT, /grammatically complete English sentence/);
  assert.match(DEFAULT_CHAT_DRAW_PROMPT, /Never use natural-language fragments/);
  assert.doesNotMatch(DEFAULT_CHAT_DRAW_PROMPT, /compact visual phrase/);
  assert.match(DEFAULT_CHAT_DRAW_PROMPT, /\[左: 1girl/);
  assert.match(DEFAULT_CHAT_DRAW_PROMPT, /\[@25,55: character tags\]/);
  assert.match(DEFAULT_CHAT_DRAW_PROMPT, /hatsune miku \(vocaloid\)/);
  assert.match(
    DEFAULT_CHAT_DRAW_PROMPT,
    /Do not repeat inherent appearance traits already encoded by that tag/
  );
  assert.match(
    DEFAULT_CHAT_DRAW_PROMPT,
    /Only when no reliable recognized character tag exists/
  );

  const truncated = parseChatDrawTags(
    "可见正文\n\n<draw>1girl\nsmile, cozy bedroom"
  );
  assert.equal(truncated.text, "可见正文");
  assert.deepEqual(truncated.prompts, ["1girl, smile, cozy bedroom"]);
  assert.deepEqual(truncated.rawPrompts, ["1girl\nsmile, cozy bedroom"]);

  const historyWithDrawTags = [
    { role: "user", parts: [{ text: "看看现在" }] },
    {
      role: "model",
      parts: [{ text: "正文\n<draw>1girl, waving</draw>" }],
    },
  ];
  assert.deepEqual(
    sanitizeConversationHistory(historyWithDrawTags),
    historyWithDrawTags,
    "隐藏绘图标签应保留在模型历史中供后续回合参考"
  );

  const drawState = { scheduled: false };
  const requests = [];
  const visible = [];
  const first = await dispatchTaggedChatResponse({
    responseText:
      "正文\n<draw>2girls, cozy cafe [左: 1girl, black hair, looking right] [@75,55: 1girl, silver hair, looking left]</draw>",
    drawingEnabled: true,
    promptSuffix: "soft lighting",
    drawState,
    sendText: async (text) => visible.push(text),
    startDrawing: async (request) => requests.push(request),
  });
  const second = await dispatchTaggedChatResponse({
    responseText: "后续\n<draw>1girl, sitting</draw>",
    drawingEnabled: true,
    drawState,
    sendText: async (text) => visible.push(text),
    startDrawing: async (request) => requests.push(request),
  });
  await first.drawTask;
  assert.deepEqual(requests, [
    {
      prompt: "2girls, cozy cafe, soft lighting",
      characters: [
        {
          prompt: "1girl, black hair, looking right",
          uc: "",
          center: { x: 0.3, y: 0.5 },
          enabled: true,
        },
        {
          prompt: "1girl, silver hair, looking left",
          uc: "",
          center: { x: 0.75, y: 0.55 },
          enabled: true,
        },
      ],
    },
  ]);
  assert.equal(second.drawTask, null);
  assert.deepEqual(visible, ["正文", "后续"]);
  assert.equal(
    first.rawDrawPrompt,
    "2girls, cozy cafe [左: 1girl, black hair, looking right] [@75,55: 1girl, silver hair, looking left]"
  );

  let started = false;
  const withoutTag = await dispatchTaggedChatResponse({
    responseText: "只有正文",
    drawingEnabled: true,
    promptSuffix: "1girl, uniform",
    drawState: { scheduled: false },
    sendText: async () => {},
    startDrawing: async () => {
      started = true;
    },
  });
  assert.equal(withoutTag.drawTask, null);
  assert.equal(started, false);
});

test("上一次 RP 绘图标签按会话和用户保存，并显示实际多角色提示词", async () => {
  const values = new Map();
  const calls = [];
  const redis = {
    async get(key) {
      return values.get(key) || null;
    },
    async set(...args) {
      calls.push(args);
      values.set(args[0], args[1]);
      return "OK";
    },
    async del(key) {
      values.delete(key);
      return 1;
    },
  };
  const ctx = { chat: { id: -1001 }, from: { id: 42 } };
  const record = {
    profileName: "小叶",
    rawPrompt:
      "2girls, cafe [左: 1girl, black hair] [右: 1girl, silver hair]",
    prompt: "2girls, cafe, warm lighting",
    characters: [
      { prompt: "1girl, black hair", center: { x: 0.3, y: 0.5 } },
      { prompt: "1girl, silver hair", center: { x: 0.7, y: 0.5 } },
    ],
  };

  await saveLastChatDraw(ctx, record, { redis, ttlSeconds: 123 });
  assert.deepEqual(calls[0].slice(2), ["EX", 123]);
  assert.notEqual(
    getLastChatDrawKey(ctx),
    getLastChatDrawKey({ chat: ctx.chat, from: { id: 43 } })
  );

  const loaded = await loadLastChatDraw(ctx, { redis });
  assert.equal(loaded.profileName, "小叶");
  assert.equal(loaded.characters.length, 2);
  const output = formatLastChatDraw(loaded);
  assert.match(output, /上一次 RP 绘图标签（角色：小叶）/);
  assert.match(output, /<draw>2girls, cafe \[左:/);
  assert.match(output, /实际提交给 NovelAI/);
  assert.match(output, /全局：2girls, cafe, warm lighting/);
  assert.match(output, /角色 2（70%, 50%）：1girl, silver hair/);
});

test("中文历史命令按角色前缀解析", () => {
  assert.deepEqual(parseChineseConversationCommand("#清空对话小樱"), {
    type: "clear",
    args: "小樱",
  });
  assert.deepEqual(parseChineseConversationCommand("回退对话小樱 2"), {
    type: "rollback",
    args: "小樱 2",
  });
  assert.deepEqual(
    parseChineseConversationCommand("#篡改对话小樱 -1 新内容"),
    { type: "tamper", args: "小樱 -1 新内容" }
  );
  assert.deepEqual(parseChineseConversationCommand("#列出对话 小樱"), {
    type: "list",
    args: "小樱",
  });
  assert.equal(parseChineseConversationCommand("普通聊天"), null);

  const short = { name: "角色甲", prefixes: ["小"] };
  const long = { name: "角色乙", prefixes: ["小樱"] };
  assert.deepEqual(consumeConversationPrefix([short, long], "小樱 2"), {
    profile: long,
    rest: "2",
  });
  assert.equal(consumeConversationPrefix([short, long], "角色乙 2"), null);
});

test("角色可配置是否向模型保留命中的触发前缀", () => {
  const stripProfile = {
    name: "去前缀",
    prefixes: ["小叶"],
    keepTriggerPrefix: false,
  };
  const keepProfile = {
    name: "保留前缀",
    prefixes: ["小叶"],
    keepTriggerPrefix: true,
  };

  const stripped = matchProfilePrefix([stripProfile], "小叶 你好");
  assert.equal(buildProfileTriggerQuery(stripped, "小叶 你好"), "你好");

  const kept = matchProfilePrefix([keepProfile], "小叶 你好");
  assert.equal(buildProfileTriggerQuery(kept, "小叶 你好"), "小叶 你好");
  assert.equal(buildProfileTriggerQuery(kept, "小叶"), "小叶");

  assert.equal(
    consumeConversationPrefix([keepProfile], "小叶 2").rest,
    "2"
  );
});

test("历史回退和篡改按对话轮次与 AI 回复定位", () => {
  const history = [
    { role: "user", parts: [{ text: "问题1" }] },
    { role: "model", parts: [{ text: "回答1" }] },
    { role: "user", parts: [{ text: "问题2" }] },
    { role: "model", parts: [{ text: "回答2" }] },
    { role: "user", parts: [{ text: "问题3" }] },
    { role: "model", parts: [{ text: "回答3" }] },
  ];
  assert.deepEqual(
    rollbackConversationHistory(history, 2).history.map(
      (item) => item.parts[0].text
    ),
    ["问题1", "回答1"]
  );
  assert.deepEqual(
    rollbackConversationHistory(history, -1).history.map(
      (item) => item.parts[0].text
    ),
    ["问题2", "回答2", "问题3", "回答3"]
  );
  const changed = tamperConversationHistory(history, 1, "新回答3");
  assert.equal(changed.status, "ok");
  assert.equal(changed.history.at(-1).parts[0].text, "新回答3");
});

test("短期历史保留用户与角色文本（含隐藏绘图标签）并按轮次裁剪", () => {
  const legacy = [
    {
      role: "user",
      parts: [
        { text: "第一问" },
        { inlineData: { mimeType: "image/png", data: "BASE64" } },
      ],
    },
    {
      role: "model",
      parts: [
        { text: "内部思考", thought: true },
        { text: "回答" },
        { functionCall: { id: "call-1", name: "old-tool", args: {} } },
      ],
      toolCallIds: ["call-1"],
    },
    {
      role: "function",
      parts: [{ functionResponse: { id: "call-1", response: "secret" } }],
    },
  ];
  assert.deepEqual(sanitizeConversationHistory(legacy), [
    { role: "user", parts: [{ text: "第一问" }] },
    { role: "model", parts: [{ text: "回答" }] },
  ]);

  const twoRounds = [
    { role: "user", parts: [{ text: "一" }] },
    { role: "model", parts: [{ text: "答一" }] },
    { role: "user", parts: [{ text: "二" }] },
    { role: "model", parts: [{ text: "答二" }] },
  ];
  assert.deepEqual(trimConversationHistoryByRounds(twoRounds, 1), [
    { role: "user", parts: [{ text: "二" }] },
    { role: "model", parts: [{ text: "答二" }] },
  ]);
});

test("敏感配置仍支持环境变量引用", () => {
  const previous = process.env.SAKURATG_TEST_SECRET;
  process.env.SAKURATG_TEST_SECRET = "secret-value";
  try {
    assert.equal(
      resolveConfigValue("${SAKURATG_TEST_SECRET}"),
      "secret-value"
    );
    assert.equal(
      resolveConfigValue("Bearer ${SAKURATG_TEST_SECRET}"),
      "Bearer secret-value"
    );
  } finally {
    if (previous === undefined) delete process.env.SAKURATG_TEST_SECRET;
    else process.env.SAKURATG_TEST_SECRET = previous;
  }
});

test("路由保留调度与推理配置，含图请求不预筛选目标", async () => {
  resetRoutingCursors();
  assert.deepEqual(
    orderScheduledItems(
      [
        { id: "low", priority: 0, enabled: true },
        { id: "high", priority: 10, enabled: true },
        { id: "off", priority: 99, enabled: false },
      ],
      "priority",
      "test"
    ).map((item) => item.id),
    ["high", "low"]
  );
  assert.deepEqual(
    resolveGenerationSettings(
      { reasoningLevel: "off", temperature: -1, topP: -1 },
      {
        openaiReasoningEffort: "inherit",
        geminiThinkingLevel: "inherit",
        geminiThinkingBudget: -2,
        temperatureOverride: -1,
        topPOverride: -1,
      }
    ),
    {
      temperature: undefined,
      topP: undefined,
      openaiEnableThinking: false,
      openaiReasoningEffort: "none",
      geminiThinkingLevel: undefined,
      geminiThinkingBudget: 0,
    }
  );

  await withConfig(chatConfig(), () => {
    const all = createRouteExecutionPlan("roleplay");
    assert.deepEqual(
      all.attempts.map((attempt) => attempt.target.id),
      ["primary", "fallback"]
    );
  });
});

test("图片沿普通路由原样回退，不产生工具或识图转写", async (t) => {
  const captured = [];
  const baseURL = await startOpenAIMock(
    t,
    async ({ request, response, body }) => {
      assert.equal(request.url, "/v1/chat/completions");
      captured.push(body);
      if (body.model === "primary-model") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "该目标拒绝了图片",
              type: "invalid_request_error",
            },
          })
        );
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "我看到了图片。" },
              finish_reason: "stop",
            },
          ],
        })
      );
    }
  );

  await withConfig(chatConfig({ baseURL }), async () => {
    const result = await getAI(
      "roleplay",
      {},
      [
        { text: "这是什么？" },
        { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
      ],
      "保持角色设定",
      [
        { role: "user", parts: [{ text: "上一问" }] },
        { role: "model", parts: [{ text: "上一答" }] },
      ]
    );
    assert.equal(result.text, "我看到了图片。");
  });

  assert.deepEqual(
    captured.map((request) => request.model),
    ["primary-model", "fallback-model"]
  );
  for (const request of captured) {
    assert.equal(Object.hasOwn(request, "tools"), false);
    assert.equal(Object.hasOwn(request, "tool_choice"), false);
    const current = request.messages.at(-1);
    assert.equal(current.role, "user");
    assert.equal(
      current.content.some(
        (part) =>
          part.type === "image_url" &&
          part.image_url.url === "data:image/png;base64,aGVsbG8="
      ),
      true
    );
  }
  assert.equal(JSON.stringify(captured).includes("[工具识图结果]"), false);
});

test("旧 supportsImages 值不再影响图片路由", async () => {
  const config = chatConfig();
  for (const target of config.ai.routes[0].targets) {
    target.supportsImages = false;
  }
  await withConfig(config, () => {
    const plan = createRouteExecutionPlan("roleplay");
    assert.deepEqual(
      plan.attempts.map((attempt) => attempt.target.id),
      ["primary", "fallback"]
    );
  });
});

test("模块只注册角色扮演、NovelAI、历史、停止和 /id", () => {
  const commands = [];
  const hears = [];
  const events = [];
  const middleware = [];
  const bot = {
    command(name) {
      commands.push(name);
    },
    hears(pattern) {
      hears.push(pattern);
    },
    on(name) {
      events.push(name);
    },
    use(handler) {
      middleware.push(handler);
    },
  };
  for (const module of modules) {
    module.installMiddleware?.(bot);
    module.register(bot);
  }

  assert.deepEqual(
    modules.map((module) => module.name),
    ["identity", "ai"]
  );
  assert.deepEqual(commands.sort(), [
    "addvibe",
    "ai",
    "aihelp",
    "delvibe",
    "forget",
    "id",
    "lastdraw",
    "nai",
    "stop",
    "vibes",
  ]);
  for (const item of TELEGRAM_COMMAND_MENU) {
    assert.equal(commands.includes(item.command), true, item.command);
  }
  for (const removed of [
    "draw",
    "video",
    "remember",
    "memories",
    "models",
    "loli",
    "ping",
    "status",
  ]) {
    assert.equal(commands.includes(removed), false, removed);
  }
  assert.equal(events.includes("message"), true);
  assert.equal(middleware.length, 1);
  assert.ok(hears.length >= 5);
  const lastDrawPattern = hears.find(
    (pattern) => pattern instanceof RegExp && pattern.test("查看上一次绘图标签")
  );
  assert.ok(lastDrawPattern);
  for (const command of [
    "绘图标签",
    "#查看绘图标签",
    "上次绘图标签",
    "查看上一次绘图标签",
  ]) {
    assert.equal(lastDrawPattern.test(command), true, command);
  }
});

test("启动时同步公开 Telegram 命令菜单并恢复命令按钮", async () => {
  const calls = [];
  const logs = [];
  const bot = {
    api: {
      async setMyCommands(commands) {
        calls.push(["commands", commands]);
        return true;
      },
      async setChatMenuButton(options) {
        calls.push(["menu", options]);
        return true;
      },
    },
  };
  const result = await syncTelegramCommandMenu(bot, {
    log: {
      info: (message) => logs.push(["info", message]),
      warn: (message) => logs.push(["warn", message]),
    },
  });

  assert.deepEqual(result, {
    commandsSynced: true,
    menuButtonSynced: true,
  });
  assert.deepEqual(calls, [
    ["commands", TELEGRAM_COMMAND_MENU],
    ["menu", { menu_button: { type: "commands" } }],
  ]);
  assert.deepEqual(
    TELEGRAM_COMMAND_MENU.map((item) => item.command),
    ["ai", "nai", "lastdraw", "vibes", "stop", "forget", "aihelp", "id"]
  );
  assert.equal(
    TELEGRAM_COMMAND_MENU.some((item) => item.command === "addvibe"),
    false
  );
  assert.equal(
    TELEGRAM_COMMAND_MENU.every(
      (item) => /^[a-z0-9_]{1,32}$/.test(item.command) && item.description
    ),
    true
  );
  assert.equal(logs.some(([level]) => level === "warn"), false);
  assert.match(logs[0][1], /8 项/);
});

test("Telegram 命令菜单同步失败不会阻断启动", async () => {
  const warnings = [];
  const result = await syncTelegramCommandMenu(
    {
      api: {
        async setMyCommands() {
          throw new Error("commands unavailable");
        },
        async setChatMenuButton() {
          throw new Error("menu unavailable");
        },
      },
    },
    {
      log: {
        info: () => {},
        warn: (message) => warnings.push(message),
      },
    }
  );

  assert.deepEqual(result, {
    commandsSynced: false,
    menuButtonSynced: false,
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /命令列表同步失败/);
  assert.match(warnings[1], /菜单按钮同步失败/);
});

test("废弃功能实现文件和识图回退代码均已移除", () => {
  const removedFiles = [
    "src/ai/agentRunner.js",
    "src/ai/groupContext.js",
    "src/ai/groupMessageStore.js",
    "src/ai/mcpManager.js",
    "src/ai/memoryStore.js",
    "src/ai/media/imageProvider.js",
    "src/ai/media/videoProvider.js",
    "src/ai/modelCatalog.js",
    "src/ai/promptAddons.js",
    "src/modules/loliImage.js",
    "src/modules/ping.js",
  ];
  for (const relativePath of removedFiles) {
    assert.equal(
      fs.existsSync(path.join(process.cwd(), relativePath)),
      false,
      relativePath
    );
  }

  const chatSource = [
    "src/ai/chatRunner.js",
    "src/ai/getAI.js",
    "src/modules/ai.js",
  ]
    .map((file) => fs.readFileSync(path.join(process.cwd(), file), "utf8"))
    .join("\n");
  assert.equal(chatSource.includes("[工具识图结果]"), false);
  assert.equal(chatSource.includes("toolsRoute"), false);
  assert.equal(chatSource.includes("functionCall"), false);
});
