import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import Config from "../src/config.js";
import { AISchema } from "../src/ai/configSchema.js";
import { runChat } from "../src/ai/chatRunner.js";
import { formatConversationList } from "../src/ai/conversationCommands.js";
import {
  getConversationSummaryKey,
  getStoredHistoryRoundLimit,
  loadConversationSummary,
  runConversationExclusive,
  saveConversationHistory,
  saveConversationSummary,
} from "../src/ai/conversationHistory.js";
import {
  compressConversationHistory,
  planHistoryCompression,
} from "../src/ai/conversationSummary.js";
import { AI_REQUEST_STOPPED_MESSAGE, getAI } from "../src/ai/getAI.js";
import {
  DEFAULT_HISTORY_SUMMARY_PROMPT,
  formatHistorySummarySection,
} from "../src/ai/historySummaryPrompt.js";
import { requestStopCurrentTasks } from "../src/ai/stopFlag.js";
import {
  createTelegramStreamPresenter,
  renderStreamPreview,
  streamingVisibleText,
} from "../src/ai/telegramStream.js";
import { modules } from "../src/modules/index.js";

const silentLog = { info() {}, warn() {}, error() {} };

function withConfig(config, task) {
  const previous = Config.config;
  Config.config = config;
  return Promise.resolve()
    .then(task)
    .finally(() => {
      Config.config = previous;
    });
}

async function settle() {
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createFakeClock() {
  let current = 10_000;
  let timers = [];
  return {
    now: () => current,
    setTimer(fn, ms) {
      const timer = { at: current + Math.max(0, ms), fn };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timers = timers.filter((item) => item !== timer);
    },
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        current = Math.max(current, next.at);
        next.fn();
        await settle();
      }
      current = target;
      await settle();
    },
  };
}

function telegramError(description, extra = {}) {
  return Object.assign(new Error(description), { description, ...extra });
}

function rounds(count, start = 1) {
  return Array.from({ length: count }, (_, index) => [
    { role: "user", parts: [{ text: `问${start + index}` }] },
    { role: "model", parts: [{ text: `答${start + index}` }] },
  ]).flat();
}

function createRedisMock() {
  const values = new Map();
  const calls = [];
  return {
    values,
    calls,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value, ...args) {
      calls.push(["set", key, ...args]);
      values.set(key, value);
      return "OK";
    },
    async del(...keys) {
      let deleted = 0;
      for (const key of keys) if (values.delete(key)) deleted += 1;
      return deleted;
    },
    async expire(key, ttl) {
      calls.push(["expire", key, ttl]);
      return values.has(key) ? 1 : 0;
    },
  };
}

async function startMockServer(t, handler) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : null;
    await handler({ request, response, body });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

function openAIChunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function startSse(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

function writeOpenAIStream(response, pieces) {
  startSse(response);
  for (const content of pieces) response.write(openAIChunk({ content }));
  response.write(openAIChunk({}, "stop"));
  response.end("data: [DONE]\n\n");
}

function writeOpenAICompletion(response, content) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      id: "chatcmpl-json",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
    })
  );
}

function aiConfig({
  baseURL = "http://127.0.0.1:1/v1",
  protocol = "openai",
  streaming = {},
  profile = {},
} = {}) {
  return {
    telegram: { localApiServer: false },
    ai: AISchema.parse({
      privateAutoReply: true,
      defaultProfile: "sakura",
      roleCards: [{ name: "sakura", prompt: "你是小樱。" }],
      profiles: [
        {
          name: "sakura",
          prefixes: ["小樱"],
          route: "roleplay",
          history: false,
          ...profile,
        },
      ],
      providers: [
        {
          id: "mock",
          protocol,
          baseURL,
          credentials: [{ id: "primary", apiKey: "test-key" }],
        },
      ],
      routes: [
        {
          id: "roleplay",
          strategy: "priority",
          retryDelayMs: 0,
          maxAttempts: 3,
          targets: [
            { id: "primary", provider: "mock", model: "primary-model", priority: 10 },
            { id: "fallback", provider: "mock", model: "fallback-model", priority: 0 },
          ],
        },
      ],
      streaming,
    }),
  };
}

test("流式预览隐藏完整和未写完的 draw 标签", () => {
  assert.equal(streamingVisibleText("你好<draw>1girl</draw>"), "你好");
  assert.equal(streamingVisibleText("你好\n<draw>1girl, smi"), "你好");
  assert.equal(streamingVisibleText("你好<dr"), "你好");
  assert.equal(streamingVisibleText("你好<"), "你好");
  assert.equal(streamingVisibleText("<drawing> 不是标签"), "<drawing> 不是标签");
  assert.equal(
    streamingVisibleText("前<draw>a</draw>中<draw>b</draw>后"),
    "前中后"
  );

  const long = Array.from({ length: 1000 }, (_, index) => `第${index}行剧情`).join(
    "\n"
  );
  assert.ok(long.length > 3500);
  const preview = renderStreamPreview(long);
  assert.ok(preview.raw.startsWith("…\n第"));
  assert.ok(preview.raw.length <= 3502);
  assert.ok(preview.raw.endsWith("第999行剧情"));
  assert.equal(renderStreamPreview("短文本").raw, "短文本");
});

test("私聊用草稿节流刷新，结束后发送正式消息", async () => {
  const clock = createFakeClock();
  const drafts = [];
  const replies = [];
  const displayed = [];
  const ctx = {
    chat: { id: 7, type: "private" },
    api: {
      async sendMessageDraft(chatId, draftId, text, other) {
        drafts.push({ chatId, draftId, text, other });
        return true;
      },
    },
    async reply(text, other) {
      replies.push({ text, other });
      return { message_id: replies.length };
    },
  };
  const presenter = createTelegramStreamPresenter(ctx, {
    privateIntervalMs: 500,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFirstDisplay: (mode) => displayed.push(mode),
    log: silentLog,
  });
  assert.equal(presenter.mode, "draft");

  presenter.update("你");
  presenter.update("你好");
  await clock.advance(499);
  assert.equal(drafts.length, 0);
  await clock.advance(1);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].chatId, 7);
  assert.equal(drafts[0].text, "你好");
  assert.equal(drafts[0].other.parse_mode, "HTML");
  assert.deepEqual(displayed, ["draft"]);

  presenter.update("你好，**旅人**<dr");
  await clock.advance(500);
  assert.equal(drafts.at(-1).text, "你好，<b>旅人</b>");

  presenter.update("你好，**旅人**<draw>1girl, smile");
  await clock.advance(500);
  assert.equal(drafts.length, 2, "draw 标签不应触发新的草稿");
  assert.equal(new Set(drafts.map((draft) => draft.draftId)).size, 1);
  assert.ok(drafts[0].draftId > 0);

  await presenter.finish("你好，**旅人**");
  assert.deepEqual(replies, [
    { text: "你好，<b>旅人</b>", other: { parse_mode: "HTML" } },
  ]);

  presenter.update("迟到的内容");
  await clock.advance(1000);
  assert.equal(drafts.length, 2);
  assert.equal(replies.length, 1);
});

test("Bot API 不支持草稿时私聊自动改为编辑消息", async () => {
  const clock = createFakeClock();
  const replies = [];
  const edits = [];
  const warnings = [];
  let lastText = null;
  let editCalls = 0;
  const ctx = {
    chat: { id: 7, type: "private" },
    api: {
      async sendMessageDraft() {
        throw telegramError("Bad Request: method not found", {
          error_code: 404,
        });
      },
      async editMessageText(chatId, messageId, text, other) {
        editCalls += 1;
        if (text === lastText) {
          throw telegramError("Bad Request: message is not modified");
        }
        lastText = text;
        edits.push({ chatId, messageId, text, other });
        return true;
      },
    },
    async reply(text, other) {
      lastText = text;
      replies.push({ text, other });
      return { message_id: 99 };
    },
  };
  const presenter = createTelegramStreamPresenter(ctx, {
    privateIntervalMs: 500,
    groupIntervalMs: 2000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: { ...silentLog, warn: (message) => warnings.push(message) },
  });

  presenter.update("第一段");
  await clock.advance(500);
  assert.equal(presenter.mode, "edit");
  assert.match(warnings[0], /草稿推送失败/);
  assert.deepEqual(replies, [
    { text: "第一段", other: { parse_mode: "HTML" } },
  ]);

  presenter.update("第一段\n第二段");
  await clock.advance(2000);
  assert.deepEqual(edits.at(-1), {
    chatId: 7,
    messageId: 99,
    text: "第一段\n第二段",
    other: { parse_mode: "HTML" },
  });

  const callsBeforeFinish = editCalls;
  const sent = await presenter.finish("第一段\n第二段");
  assert.deepEqual(sent, [{ message_id: 99 }]);
  assert.equal(replies.length, 1, "最终内容未变化时不重复发送");
  assert.equal(editCalls, callsBeforeFinish, "最终内容未变化时不再编辑");
});

test("群聊先发消息再编辑，长正文结束时拆分发送", async () => {
  const clock = createFakeClock();
  const replies = [];
  const edits = [];
  const ctx = {
    chat: { id: -100, type: "supergroup" },
    api: {
      async editMessageText(chatId, messageId, text, other) {
        edits.push({ chatId, messageId, text, other });
        return true;
      },
    },
    async reply(text, other) {
      replies.push({ text, other });
      return { message_id: 500 + replies.length };
    },
  };
  const presenter = createTelegramStreamPresenter(ctx, {
    groupIntervalMs: 2000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: silentLog,
  });
  assert.equal(presenter.mode, "edit");

  presenter.update("开场");
  await clock.advance(1999);
  assert.equal(replies.length, 0);
  await clock.advance(1);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "开场");

  presenter.update("开场，继续");
  await clock.advance(1000);
  assert.equal(edits.length, 0, "群聊编辑需要等满间隔");
  await clock.advance(1000);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].messageId, 501);

  const longText = "这是一段很长的剧情。\n".repeat(500).trim();
  const sent = await presenter.finish(longText);
  assert.ok(sent.length >= 2);
  assert.equal(sent[0].message_id, 501);
  assert.equal(edits.at(-1).messageId, 501);
  assert.ok(edits.at(-1).text.length <= 3900);
  assert.equal(replies.length, sent.length);
  const delivered = [edits.at(-1).text, ...replies.slice(1).map((r) => r.text)]
    .join("\n")
    .replace(/\s+/g, "");
  assert.equal(delivered, longText.replace(/\s+/g, ""));
});

test("群聊编辑遇到 429 按 retry_after 暂停，停止时删除预览消息", async () => {
  const clock = createFakeClock();
  const edits = [];
  const deleted = [];
  let failNextEdit = true;
  const ctx = {
    chat: { id: -100, type: "group" },
    api: {
      async editMessageText(_chatId, messageId, text) {
        if (failNextEdit) {
          failNextEdit = false;
          throw telegramError("Too Many Requests: retry after 5", {
            error_code: 429,
            parameters: { retry_after: 5 },
          });
        }
        edits.push({ messageId, text });
        return true;
      },
      async deleteMessage(chatId, messageId) {
        deleted.push({ chatId, messageId });
        return true;
      },
    },
    async reply() {
      return { message_id: 42 };
    },
  };
  const presenter = createTelegramStreamPresenter(ctx, {
    groupIntervalMs: 1000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: silentLog,
  });

  presenter.update("一");
  await clock.advance(1000);
  presenter.update("一二");
  await clock.advance(1000);
  assert.equal(edits.length, 0, "第一次编辑被 429 拒绝");
  presenter.update("一二三");
  await clock.advance(4999);
  assert.equal(edits.length, 0, "retry_after 期间不再编辑");
  await clock.advance(1);
  assert.deepEqual(edits, [{ messageId: 42, text: "一二三" }]);

  // A fallback attempt restarting with no visible text must not spin timers.
  presenter.update("<draw>1girl");
  await clock.advance(1000);
  presenter.update("");
  await clock.advance(5000);
  assert.equal(edits.length, 1);

  await presenter.close();
  assert.deepEqual(deleted, [{ chatId: -100, messageId: 42 }]);
  await presenter.close();
  assert.equal(deleted.length, 1);
});

test("OpenAI 路由流式返回累计文本并保持原有请求参数", async (t) => {
  const captured = [];
  const baseURL = await startMockServer(t, async ({ response, body }) => {
    captured.push(body);
    writeOpenAIStream(response, ["小樱", "轻轻", "点头。"]);
  });

  const seen = [];
  await withConfig(aiConfig({ baseURL: `${baseURL}/v1` }), async () => {
    const result = await getAI(
      "roleplay",
      {},
      [{ text: "你好" }],
      "保持角色设定",
      [],
      { onText: (text) => seen.push(text) }
    );
    assert.equal(result.text, "小樱轻轻点头。");
  });
  assert.deepEqual(seen, ["小樱", "小樱轻轻", "小樱轻轻点头。"]);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].stream, true);
  assert.equal(captured[0].model, "primary-model");
  assert.equal(captured[0].messages[0].role, "system");
});

test("端点忽略 stream=true 时改用非流式请求", async (t) => {
  const captured = [];
  const baseURL = await startMockServer(t, async ({ response, body }) => {
    captured.push(body);
    writeOpenAICompletion(response, "普通 JSON 回复");
  });

  const seen = [];
  await withConfig(aiConfig({ baseURL: `${baseURL}/v1` }), async () => {
    const result = await getAI("roleplay", {}, [{ text: "你好" }], "", [], {
      onText: (text) => seen.push(text),
    });
    assert.equal(result.text, "普通 JSON 回复");
  });
  assert.deepEqual(
    captured.map((body) => [body.model, body.stream]),
    [
      ["primary-model", true],
      ["primary-model", false],
    ]
  );
  assert.deepEqual(seen, ["普通 JSON 回复"]);
});

test("停止信号会中断流式请求且不再回退到下一个目标", async (t) => {
  const captured = [];
  const baseURL = await startMockServer(t, async ({ request, response, body }) => {
    captured.push(body.model);
    startSse(response);
    response.write(openAIChunk({ content: "写到一半" }));
    await new Promise((resolve) => request.socket.once("close", resolve));
  });

  const controller = new AbortController();
  await withConfig(aiConfig({ baseURL: `${baseURL}/v1` }), async () => {
    const result = await getAI("roleplay", {}, [{ text: "你好" }], "", [], {
      onText: () => controller.abort(),
      signal: controller.signal,
    });
    assert.equal(result, AI_REQUEST_STOPPED_MESSAGE);
  });
  assert.deepEqual(captured, ["primary-model"]);
});

test("流式请求超时视为失败，不把半截回复当作完成", async (t) => {
  const captured = [];
  const baseURL = await startMockServer(t, async ({ request, response, body }) => {
    captured.push(body.model);
    startSse(response);
    response.write(openAIChunk({ content: "半句" }));
    await new Promise((resolve) => request.socket.once("close", resolve));
  });

  const config = aiConfig({ baseURL: `${baseURL}/v1` });
  config.ai.requestTimeoutMs = 300;
  await withConfig(config, async () => {
    const result = await getAI("roleplay", {}, [{ text: "你好" }], "", [], {
      onText: () => {},
    });
    assert.equal(typeof result, "string");
    assert.match(result, /请求失败/);
  });
  assert.deepEqual(captured, ["primary-model", "fallback-model"]);
});

test("Gemini 路由流式输出跳过思考片段", async (t) => {
  const urls = [];
  const baseURL = await startMockServer(t, async ({ request, response }) => {
    urls.push(request.url);
    startSse(response);
    const chunks = [
      { parts: [{ text: "先想想", thought: true }] },
      { parts: [{ text: "樱花" }] },
      { parts: [{ text: "飘落。" }], finishReason: "STOP" },
    ];
    for (const { parts, finishReason } of chunks) {
      response.write(
        `data: ${JSON.stringify({
          candidates: [
            { content: { role: "model", parts }, ...(finishReason && { finishReason }) },
          ],
        })}\n\n`
      );
    }
    response.end();
  });

  const seen = [];
  await withConfig(
    aiConfig({ baseURL, protocol: "gemini" }),
    async () => {
      const result = await getAI("roleplay", {}, [{ text: "你好" }], "设定", [], {
        onText: (text) => seen.push(text),
      });
      assert.equal(result.text, "樱花飘落。");
    }
  );
  assert.deepEqual(seen, ["樱花", "樱花飘落。"]);
  assert.match(urls[0], /primary-model:streamGenerateContent/);
});

test("停止请求会中断进行中的对话并标记为已停止", async () => {
  const ctx = { chat: { id: 9, type: "private" }, from: { id: 9 }, me: { id: 1 } };
  const history = rounds(1);
  const result = await runChat({
    ctx,
    route: "roleplay",
    queryParts: [{ text: "继续" }],
    prompt: "设定",
    history,
    onText: () => {},
    requestModel: async (_route, _ctx, _query, _prompt, _history, options) => {
      assert.equal(typeof options.onText, "function");
      options.onText("写到一半");
      setImmediate(() => assert.equal(requestStopCurrentTasks(ctx), true));
      await new Promise((resolve) =>
        options.signal.addEventListener("abort", resolve, { once: true })
      );
      return AI_REQUEST_STOPPED_MESSAGE;
    },
  });
  assert.equal(result.status, "stopped");
  assert.deepEqual(result.history, history);
  assert.equal(requestStopCurrentTasks(ctx), false);
});

test("私聊消息端到端走流式草稿，最终正文隐藏 draw 标签", async (t) => {
  const baseURL = await startMockServer(t, async ({ response }) => {
    startSse(response);
    response.write(openAIChunk({ content: "小樱看向你，" }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    response.write(openAIChunk({ content: "露出微笑。" }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    response.write(openAIChunk({ content: "<draw>1girl, smile</draw>" }));
    response.write(openAIChunk({}, "stop"));
    response.end("data: [DONE]\n\n");
  });

  const handlers = {};
  const middleware = [];
  const bot = {
    command() {},
    hears() {},
    on(name, handler) {
      handlers[name] = handler;
    },
    use(handler) {
      middleware.push(handler);
    },
  };
  for (const module of modules) {
    module.installMiddleware?.(bot);
    module.register(bot);
  }

  const drafts = [];
  const replies = [];
  const ctx = {
    chat: { id: 77, type: "private" },
    from: { id: 77, first_name: "旅人" },
    me: { id: 1, username: "sakura_bot" },
    message: { text: "你好" },
    api: {
      async sendMessageDraft(_chatId, _draftId, text) {
        drafts.push(text);
        return true;
      },
    },
    async replyWithChatAction() {
      return true;
    },
    async reply(text, other) {
      replies.push({ text, other });
      return { message_id: replies.length };
    },
  };

  await withConfig(
    aiConfig({
      baseURL: `${baseURL}/v1`,
      streaming: { privateIntervalMs: 200 },
    }),
    async () => {
      await middleware[0](ctx, () => handlers.message(ctx));
    }
  );

  assert.ok(drafts.length >= 1, "生成过程中至少推送一次草稿");
  assert.ok(drafts.every((text) => !text.includes("draw")));
  assert.deepEqual(replies, [
    { text: "小樱看向你，露出微笑。", other: { parse_mode: "HTML" } },
  ]);
});

test("历史压缩只在超过上限后批量压缩较早轮次", () => {
  assert.equal(
    planHistoryCompression(rounds(4), { maxRounds: 4, keepRounds: 2 }),
    null
  );
  const plan = planHistoryCompression(rounds(5), {
    maxRounds: 4,
    keepRounds: 2,
  });
  assert.equal(plan.compressRounds.length, 3);
  assert.equal(plan.keptRounds.length, 2);
  assert.equal(plan.keptRounds[0][0].parts[0].text, "问4");

  const clamped = planHistoryCompression(rounds(5), {
    maxRounds: 4,
    keepRounds: 10,
  });
  assert.equal(clamped.keptRounds.length, 3);
  assert.equal(
    planHistoryCompression(rounds(5), { maxRounds: 0, keepRounds: 2 }),
    null
  );
});

function createMemoryStore(history, summary = "") {
  const state = { history, summary, saves: [] };
  return {
    state,
    async loadHistory() {
      return structuredClone(state.history);
    },
    async saveHistory(_ctx, next) {
      state.history = structuredClone(next);
      state.saves.push("history");
    },
    async loadSummary() {
      return state.summary;
    },
    async saveSummary(_ctx, next) {
      state.summary = next;
      state.saves.push("summary");
    },
  };
}

const summaryConfig = {
  chatHistoryLength: 4,
  historySummary: { enabled: true, keepRounds: 2, prompt: "请压缩剧情" },
};

test("压缩沿用当前对话的系统提示词，并以压缩指令作为最后一条消息", async () => {
  const store = createMemoryStore(rounds(5), "旧的前情提要");
  const requests = [];
  const result = await compressConversationHistory({
    ctx: {},
    historyName: "小樱",
    route: "roleplay",
    buildSystemPrompt: (summary) =>
      ["你是小樱。", formatHistorySummarySection(summary)]
        .filter(Boolean)
        .join("\n\n"),
    aiConfig: summaryConfig,
    store,
    log: silentLog,
    requestModel: async (route, _ctx, queryParts, prompt, history) => {
      requests.push({ route, queryParts, prompt, history });
      return { text: "新的前情提要。<draw>1girl, smile</draw>" };
    },
  });

  assert.equal(result.status, "compressed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].route, "roleplay");
  assert.equal(
    requests[0].prompt,
    "你是小樱。\n\n" + formatHistorySummarySection("旧的前情提要")
  );
  assert.deepEqual(requests[0].queryParts, [{ text: "请压缩剧情" }]);
  assert.deepEqual(requests[0].history, rounds(3));
  assert.equal(store.state.summary, "新的前情提要。");
  assert.deepEqual(store.state.history, rounds(2, 4));
  assert.deepEqual(store.state.saves, ["summary", "history"]);
});

test("压缩失败或期间历史变化时保留原始历史", async () => {
  const failing = createMemoryStore(rounds(5), "旧提要");
  const failed = await compressConversationHistory({
    ctx: {},
    historyName: "小樱",
    route: "roleplay",
    buildSystemPrompt: () => "",
    aiConfig: summaryConfig,
    store: failing,
    log: silentLog,
    requestModel: async () => "路由“roleplay”请求失败，请查看机器人日志",
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failing.state.history, rounds(5));
  assert.equal(failing.state.summary, "旧提要");

  const changing = createMemoryStore(rounds(5), "");
  const stale = await compressConversationHistory({
    ctx: {},
    historyName: "小樱",
    route: "roleplay",
    buildSystemPrompt: () => "",
    aiConfig: summaryConfig,
    store: changing,
    log: silentLog,
    requestModel: async () => {
      changing.state.history = [];
      return { text: "不应写入" };
    },
  });
  assert.equal(stale.status, "stale");
  assert.equal(changing.state.summary, "");
  assert.deepEqual(changing.state.saves, []);

  let called = false;
  const skipped = await compressConversationHistory({
    ctx: {},
    historyName: "小樱",
    route: "roleplay",
    buildSystemPrompt: () => "",
    aiConfig: summaryConfig,
    store: createMemoryStore(rounds(4)),
    log: silentLog,
    requestModel: async () => {
      called = true;
      return { text: "x" };
    },
  });
  assert.equal(skipped.status, "skipped");
  assert.equal(called, false);
});

test("前情提要随历史保存续期，开启压缩时暂存两倍轮数", async () => {
  const redis = createRedisMock();
  const ctx = { chat: { id: -5 }, from: { id: 6 } };
  const base = AISchema.parse({});
  assert.equal(base.historySummary.enabled, true);
  assert.equal(base.historySummary.keepRounds, 10);
  assert.equal(base.historySummary.prompt, DEFAULT_HISTORY_SUMMARY_PROMPT);
  assert.equal(base.streaming.enabled, true);
  assert.equal(base.streaming.privateIntervalMs, 800);
  assert.equal(base.streaming.groupIntervalMs, 2000);

  await withConfig(
    { ai: AISchema.parse({ chatHistoryLength: 2, historyTtlSeconds: 7200 }) },
    async () => {
      assert.equal(getStoredHistoryRoundLimit(), 4);
      await saveConversationSummary(ctx, "  提要内容  ", "小樱", { redis });
      assert.equal(
        await loadConversationSummary(ctx, "小樱", { redis }),
        "提要内容"
      );
      const history = rounds(6);
      await saveConversationHistory(ctx, history, "小樱", { redis });
      assert.equal(history.length, 8, "保留 4 轮等待压缩");
      assert.deepEqual(redis.calls.at(-1), [
        "expire",
        getConversationSummaryKey(ctx, "小樱"),
        7200,
      ]);
    }
  );

  await withConfig(
    {
      ai: AISchema.parse({
        chatHistoryLength: 2,
        historySummary: { enabled: false },
      }),
    },
    () => {
      assert.equal(getStoredHistoryRoundLimit(), 2);
    }
  );

  assert.notEqual(
    getConversationSummaryKey(ctx, "小樱"),
    getConversationSummaryKey({ chat: ctx.chat, from: { id: 7 } }, "小樱")
  );
});

test("同一会话的任务串行执行，失败不阻塞后续任务", async () => {
  const events = [];
  let release;
  const first = runConversationExclusive("conv:a", async () => {
    events.push("a1-start");
    await new Promise((resolve) => {
      release = resolve;
    });
    events.push("a1-end");
    throw new Error("first failed");
  });
  const second = runConversationExclusive("conv:a", async () => {
    events.push("a2");
    return "ok";
  });
  const other = runConversationExclusive("conv:b", async () => {
    events.push("b1");
  });

  await other;
  await settle();
  assert.deepEqual(events, ["a1-start", "b1"]);
  release();
  await assert.rejects(first, /first failed/);
  assert.equal(await second, "ok");
  assert.deepEqual(events, ["a1-start", "b1", "a1-end", "a2"]);
});

test("查看对话时先显示前情提要", () => {
  const output = formatConversationList(
    rounds(1),
    { name: "sakura", prefixes: ["小樱"] },
    "两人在樱花树下重逢。"
  );
  assert.match(output, /共 1 轮/);
  assert.ok(output.indexOf("【前情提要】") < output.indexOf("【第 1 轮】"));
  assert.match(output, /两人在樱花树下重逢。/);
  assert.doesNotMatch(
    formatConversationList(rounds(1), { name: "sakura" }),
    /前情提要/
  );
  assert.equal(formatHistorySummarySection("  "), "");
  assert.match(formatHistorySummarySection("摘要"), /^\[前情提要\]\n/);
});
