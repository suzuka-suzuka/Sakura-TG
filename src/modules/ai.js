import Config from "../config.js";
import { logger } from "../logger.js";
import { sendImageBuffer } from "../lib/sendImage.js";
import { masterOnly } from "../middleware/auth.js";
import {
  dispatchTaggedChatResponse,
  stripChatDrawTagsFromHistory,
} from "../ai/chatDrawTags.js";
import {
  formatLastChatDraw,
  loadLastChatDraw,
  saveLastChatDraw,
} from "../ai/chatDrawHistory.js";
import { runChat } from "../ai/chatRunner.js";
import {
  CHINESE_CONVERSATION_COMMAND_PATTERN,
  CHINESE_CONVERSATION_HELP,
  handleChineseConversationCommand,
} from "../ai/conversationCommands.js";
import {
  clearAllProfilesForUser,
  clearConversationHistory,
  loadConversationHistory,
  saveConversationHistory,
} from "../ai/conversationHistory.js";
import { buildMultimodalQueryParts } from "../ai/messageParts.js";
import { parseNovelAICommandArgs } from "../ai/media/novelAICommand.js";
import {
  getNovelAIIsProcessing,
  getNovelAIQueueLength,
} from "../ai/media/novelAIProvider.js";
import {
  encodeNovelAIVibeWithService,
  generateNovelAIImagesWithService,
} from "../ai/media/novelAIService.js";
import {
  deleteNovelAIVibe,
  getNovelAIVibe,
  listNovelAIVibes,
  normalizeNovelAIVibeName,
  saveNovelAIVibe,
} from "../ai/media/novelAIVibeStore.js";
import {
  formatMediaUserError,
  redactMediaErrorMessage,
} from "../ai/media/mediaErrors.js";
import {
  buildProfileTriggerQuery,
  getPrimaryPrefix,
  matchProfilePrefix,
} from "../ai/profileTriggers.js";
import { resolveRoleCardPrompt } from "../ai/roleCards.js";
import { requestStopCurrentTasks } from "../ai/stopFlag.js";
import {
  attachAiContextAliases,
  collectTelegramImages,
  repliedMessageText,
  sendAiText,
  splitTelegramText,
  withChatAction,
} from "../ai/telegramAdapter.js";

const locks = new Map();
const LOCK_TTL_MS = 2 * 60 * 1000;

function enabledProfiles() {
  return (Config.get("ai.profiles") || []).filter(
    (profile) => profile.enabled !== false
  );
}

function defaultProfile() {
  const profiles = enabledProfiles();
  const configured = Config.get("ai.defaultProfile");
  return (
    profiles.find((profile) => profile.name === configured) ||
    profiles[0] ||
    null
  );
}

function rolePrompt(profile) {
  return resolveRoleCardPrompt(profile, Config.get("ai.roleCards") || []);
}

function chatDrawPrompt(profile) {
  const novelAI = Config.get("ai.novelAI") || {};
  if (profile?.enableNaiPainting !== true || novelAI.enabled === false) {
    return "";
  }
  return String(novelAI.chatDrawPrompt || "").trim();
}

function parseProfileQuery(rawText) {
  let query = String(rawText || "").trim();
  const profiles = enabledProfiles();
  let profile = defaultProfile();

  for (const candidate of profiles) {
    if (
      query.startsWith(`${candidate.name}:`) ||
      query.startsWith(`${candidate.name}：`)
    ) {
      profile = candidate;
      query = query.slice(candidate.name.length + 1).trim();
      break;
    }
    if (query === candidate.name || query.startsWith(`${candidate.name} `)) {
      profile = candidate;
      query = query.slice(candidate.name.length).trim();
      break;
    }
  }
  return { profile, query };
}

function lockKey(ctx) {
  return `${ctx.chat?.id || "private"}:${ctx.from?.id || "unknown"}`;
}

function acquireLock(ctx) {
  if (!Config.get("ai.enableUserLock")) return null;
  const key = lockKey(ctx);
  const current = locks.get(key);
  if (current && Date.now() - current.startedAt < LOCK_TTL_MS) return false;
  if (current?.timer) clearTimeout(current.timer);
  const lock = { startedAt: Date.now(), timer: null };
  lock.timer = setTimeout(() => {
    if (locks.get(key) === lock) locks.delete(key);
  }, LOCK_TTL_MS);
  lock.timer.unref?.();
  locks.set(key, lock);
  return lock;
}

function releaseLock(ctx, lock) {
  if (!lock) return;
  const key = lockKey(ctx);
  if (locks.get(key) !== lock) return;
  clearTimeout(lock.timer);
  locks.delete(key);
}

function hasActiveLock(ctx) {
  const key = lockKey(ctx);
  const current = locks.get(key);
  if (!current) return false;
  if (Date.now() - current.startedAt < LOCK_TTL_MS) return true;
  if (current.timer) clearTimeout(current.timer);
  locks.delete(key);
  return false;
}

async function executeChat(ctx, profile, rawQuery) {
  if (!profile) {
    await ctx.reply("尚未配置 AI 角色，请先填写 ai.profiles。");
    return;
  }
  if (!profile.route) {
    await ctx.reply(`角色“${profile.name}”没有配置模型路由。`);
    return;
  }

  const lock = acquireLock(ctx);
  if (lock === false) {
    await ctx.reply("上一条 AI 请求仍在处理中，可发送 /stop 请求停止。");
    return;
  }

  try {
    await withChatAction(ctx, "typing", async () => {
      let images;
      try {
        images = await collectTelegramImages(ctx);
      } catch (error) {
        await ctx.reply(`读取图片失败：${error.message}`);
        return;
      }

      let query = String(rawQuery || "").trim();
      const replied = repliedMessageText(ctx);
      if (replied) query = `（回复的消息：${replied}）\n${query}`.trim();
      if (!query && images.length > 0) query = "请描述并分析这张图片。";
      if (!query) {
        await ctx.reply("请输入要聊的内容。");
        return;
      }

      const historyName = getPrimaryPrefix(profile);
      const history = profile.history
        ? await loadConversationHistory(ctx, historyName)
        : [];
      const result = await runChat({
        ctx,
        route: profile.route,
        queryParts: buildMultimodalQueryParts(query, images),
        prompt: [rolePrompt(profile), chatDrawPrompt(profile)]
          .filter(Boolean)
          .join("\n\n"),
        history,
      });

      if (profile.history) {
        await saveConversationHistory(
          ctx,
          stripChatDrawTagsFromHistory(result.history),
          historyName
        );
      }
      if (result.status === "model_error") {
        await ctx.reply(result.error);
      } else if (result.status === "stopped") {
        await ctx.reply("已停止当前 AI 任务。");
      } else if (result.finalText) {
        await dispatchChatModelText(ctx, profile, result.finalText, {
          scheduled: false,
        });
      } else {
        await ctx.reply("模型没有返回可显示的文字。");
      }
    });
  } catch (error) {
    logger.error(`[AI Chat] 处理失败: ${error.message}`);
    await ctx.reply("AI 处理出错，请稍后再试。");
  } finally {
    releaseLock(ctx, lock);
  }
}

async function generateAndSendNovelAI(ctx, {
  prompt,
  images = [],
  count = 1,
  parameters = {},
  characters = [],
  onQueueStart = null,
}) {
  return withChatAction(ctx, "upload_photo", async () => {
    try {
      const buffers = await generateNovelAIImagesWithService({
        prompt,
        images,
        count,
        parameters,
        characters,
        onQueueStart,
      });
      if (buffers.length === 0) {
        return ctx.reply("NovelAI 没有返回图片。");
      }
      let sent = 0;
      for (let index = 0; index < buffers.length; index++) {
        const result = await sendImageBuffer(ctx, buffers[index], {
          filename: `novelai-${Date.now()}-${index + 1}.png`,
        });
        if (result.ok) sent++;
      }
      if (sent === 0) {
        await ctx.reply("图片已生成，但 Telegram 发送失败。");
      }
    } catch (error) {
      logger.error(
        `[NovelAI] 生成失败: ${redactMediaErrorMessage(error.message)}`
      );
      await ctx.reply(
        `创作失败：${formatMediaUserError(error, {
          kind: "image",
          provider: "novelai",
        })}`
      );
    }
  });
}

function matchArgument(ctx, index = 1) {
  const match = ctx.match;
  if (Array.isArray(match)) return String(match[index] || "").trim();
  return String(match || "").trim();
}

function novelAIVibeParameters(vibeData) {
  if (!vibeData) return {};
  return {
    reference_image_multiple: [vibeData.image],
    reference_information_extracted_multiple: [
      vibeData.informationExtracted,
    ],
    reference_strength_multiple: [vibeData.strength],
  };
}

async function handleNovelAIDraw(ctx) {
  if (Config.get("ai.novelAI.enabled") === false) {
    return ctx.reply("NovelAI 绘图已关闭。");
  }
  const parsed = parseNovelAICommandArgs(matchArgument(ctx), {
    vibes: listNovelAIVibes(),
    resolveVibe: getNovelAIVibe,
  });
  if (!parsed.isValid) {
    return ctx.reply(
      [
        "用法：绘图 [画风名] [横|方|竖] [角色站位] 提示词",
        "也可使用：/nai 提示词",
        "角色示例：[左: 1girl, blue hair] [@75,50: 1boy, black hair]",
        "回复一张图片可进行图生图。",
      ].join("\n")
    );
  }

  let images;
  try {
    images = await collectTelegramImages(ctx);
  } catch (error) {
    return ctx.reply(`读取参考图失败：${error.message}`);
  }
  if (getNovelAIIsProcessing()) {
    await ctx.reply(
      `已加入绘图队列，前方排队: ${getNovelAIQueueLength() + 1} 人`
    );
  }
  return generateAndSendNovelAI(ctx, {
    prompt: parsed.prompt,
    images,
    count: 1,
    parameters: {
      width: parsed.width,
      height: parsed.height,
      ...novelAIVibeParameters(parsed.vibeData),
    },
    characters: parsed.characters,
    onQueueStart: (remaining) => {
      const vibeHint = parsed.vibeData
        ? `（画风: ${parsed.vibeData.name}）`
        : "";
      return ctx.reply(`开始绘制${vibeHint}，当前队列剩余: ${remaining}`);
    },
  });
}

async function handleAddNovelAIVibe(ctx) {
  if (Config.get("ai.novelAI.enabled") === false) {
    return ctx.reply("NovelAI 绘图已关闭。");
  }
  let name;
  try {
    name = normalizeNovelAIVibeName(matchArgument(ctx));
  } catch (error) {
    return ctx.reply(error.message);
  }

  let images;
  try {
    images = await collectTelegramImages(ctx);
  } catch (error) {
    return ctx.reply(`读取画风参考图失败：${error.message}`);
  }
  if (!images[0]?.base64) {
    return ctx.reply("请发送图片或回复一张图片后再添加画风。");
  }

  try {
    const encoded = await encodeNovelAIVibeWithService({
      imageBase64: images[0].base64,
    });
    saveNovelAIVibe(name, encoded);
    return ctx.reply(`画风「${name}」已保存成功！`);
  } catch (error) {
    logger.error(
      `[NAI Vibe] 保存失败: ${redactMediaErrorMessage(error.message)}`
    );
    return ctx.reply(
      `保存画风失败：${formatMediaUserError(error, {
        kind: "image",
        provider: "novelai",
      })}`
    );
  }
}

async function handleDeleteNovelAIVibe(ctx) {
  let name;
  try {
    name = normalizeNovelAIVibeName(matchArgument(ctx));
  } catch (error) {
    return ctx.reply(error.message);
  }
  return ctx.reply(
    deleteNovelAIVibe(name)
      ? `画风「${name}」已删除`
      : `画风「${name}」不存在`
  );
}

async function handleListNovelAIVibes(ctx) {
  const vibes = listNovelAIVibes();
  if (vibes.length === 0) return ctx.reply("当前没有已保存的画风。");
  const list = vibes.map(
    (vibe, index) =>
      `${index + 1}. ${vibe.name}（强度: ${vibe.strength}，提取: ${vibe.informationExtracted}）`
  );
  return ctx.reply(
    ["已保存的画风：", ...list, "", "使用方式：绘图 画风名 提示词"].join(
      "\n"
    )
  );
}

async function dispatchChatModelText(
  ctx,
  profile,
  responseText,
  drawState
) {
  const novelAI = Config.get("ai.novelAI") || {};
  const dispatched = await dispatchTaggedChatResponse({
    responseText,
    drawingEnabled:
      profile?.enableNaiPainting === true && novelAI.enabled !== false,
    promptSuffix: profile?.naiPrompt || "",
    drawState,
    sendText: (text) => sendAiText(ctx, text),
    startDrawing: ({ prompt, characters }) =>
      generateAndSendNovelAI(ctx, {
        prompt,
        count: novelAI.chatDrawCount ?? 1,
        parameters: {
          width: novelAI.chatDrawWidth,
          height: novelAI.chatDrawHeight,
        },
        characters,
      }),
  });

  if (dispatched.drawTask && dispatched.drawRequest) {
    try {
      await saveLastChatDraw(ctx, {
        profileName: profile?.name || "",
        rawPrompt: dispatched.rawDrawPrompt,
        prompt: dispatched.drawRequest.prompt,
        characters: dispatched.drawRequest.characters,
      });
    } catch (error) {
      logger.warn(`[AI Chat Draw] 保存上一次绘图标签失败: ${error.message}`);
    }
  }

  if (dispatched.drawTask) {
    void dispatched.drawTask.catch((error) =>
      logger.error(
        `[AI Chat Draw] 后台任务失败: ${redactMediaErrorMessage(
          error?.message || error
        )}`
      )
    );
  }
  return dispatched;
}

async function handleLastChatDraw(ctx) {
  try {
    const record = await loadLastChatDraw(ctx);
    if (!record) {
      return ctx.reply("当前会话还没有可查看的 RP 绘图标签。");
    }
    const output = formatLastChatDraw(record);
    for (const chunk of splitTelegramText(output)) {
      await ctx.reply(chunk);
    }
  } catch (error) {
    logger.error(`[AI Chat Draw] 读取上一次绘图标签失败: ${error.message}`);
    await ctx.reply("读取上一次绘图标签失败，请稍后重试。");
  }
}

async function handleForget(ctx) {
  const input = String(ctx.match || "").trim();
  if (input.toLowerCase() === "all") {
    const count = await clearAllProfilesForUser(ctx);
    return ctx.reply(`已清除当前会话中的全部对话历史（${count} 项）。`);
  }
  const profile =
    enabledProfiles().find((item) => item.name === input) || defaultProfile();
  if (!profile) return ctx.reply("没有可清除的角色历史。");
  await clearConversationHistory(ctx, getPrimaryPrefix(profile));
  await ctx.reply(`已清除“${profile.name}”的当前对话历史。`);
}

function genericChatMatch(ctx) {
  const text = String(ctx.message?.text || ctx.message?.caption || "").trim();
  if (text.startsWith("/")) return null;
  const matched = matchProfilePrefix(enabledProfiles(), text);
  if (matched) {
    return {
      profile: matched.profile,
      query: buildProfileTriggerQuery(matched, text),
    };
  }

  const username = ctx.me?.username;
  if (username) {
    const mention = new RegExp(`^@${username}\\b`, "i");
    if (mention.test(text)) {
      return {
        profile: defaultProfile(),
        query: text.replace(mention, "").trim(),
      };
    }
  }
  if (ctx.chat?.type === "private" && Config.get("ai.privateAutoReply")) {
    return { profile: defaultProfile(), query: text };
  }
  return null;
}

export default {
  name: "ai",

  installMiddleware(bot) {
    bot.use(async (ctx, next) => {
      attachAiContextAliases(ctx);
      await next();
    });
  },

  register(bot) {
    bot.hears(CHINESE_CONVERSATION_COMMAND_PATTERN, async (ctx) => {
      await handleChineseConversationCommand(ctx, {
        profiles: enabledProfiles(),
        isBusy: hasActiveLock,
      });
    });
    bot.command("ai", async (ctx) => {
      if (!Config.get("ai.enabled")) return ctx.reply("AI 功能已关闭。");
      const { profile, query } = parseProfileQuery(ctx.match);
      await executeChat(ctx, profile, query);
    });
    bot.command("nai", handleNovelAIDraw);
    bot.command("lastdraw", handleLastChatDraw);
    bot.command("addvibe", masterOnly(handleAddNovelAIVibe));
    bot.command("delvibe", masterOnly(handleDeleteNovelAIVibe));
    bot.command("vibes", handleListNovelAIVibes);
    bot.hears(/^#?绘图\s*([\s\S]*)$/, handleNovelAIDraw);
    bot.hears(/^#?添加画风\s*(.+)$/, masterOnly(handleAddNovelAIVibe));
    bot.hears(/^#?删除画风\s*(.+)$/, masterOnly(handleDeleteNovelAIVibe));
    bot.hears(/^#?画风列表$/, handleListNovelAIVibes);
    bot.hears(
      /^#?(?:查看(?:上一次|上次|上一条)?|上一次|上次|上一条)?绘图标签$/,
      handleLastChatDraw
    );
    bot.command("stop", async (ctx) => {
      await ctx.reply(
        requestStopCurrentTasks(ctx)
          ? "已请求停止当前 AI 任务。"
          : "当前没有运行中的 AI 任务。"
      );
    });
    bot.command("forget", handleForget);
    bot.command("aihelp", async (ctx) => {
      await ctx.reply(
        [
          "/ai [角色名:] 内容 — 角色扮演对话",
          "/nai 提示词 — NovelAI 绘图；兼容“绘图”中文指令",
          "绘图 [画风名] [横|方|竖] [角色站位] 提示词 — NAI5 绘图",
          "/lastdraw 或“查看绘图标签” — 查看上一次 RP 绘图标签",
          "/addvibe、/delvibe、/vibes — 管理 NovelAI 画风",
          "/stop — 请求停止当前生成",
          "/forget [角色名|all] — 清除短期对话历史",
          "",
          CHINESE_CONVERSATION_HELP,
        ].join("\n")
      );
    });

    bot.on("message", async (ctx) => {
      if (!Config.get("ai.enabled") || ctx.from?.is_bot) return;
      const matched = genericChatMatch(ctx);
      if (!matched) return;
      await executeChat(ctx, matched.profile, matched.query);
    });
  },

  shutdown() {
    for (const lock of locks.values()) clearTimeout(lock.timer);
    locks.clear();
  },
};
