import {
  clearAllConversationHistories,
  clearAllProfilesForUser,
  clearConversationHistory,
  groupConversationRounds,
  loadConversationHistory,
  saveConversationHistory,
} from "./conversationHistory.js";
import {
  getPrimaryPrefix,
  getProfilePrefixes,
} from "./profileTriggers.js";
import { requestStopCurrentTasks } from "./stopFlag.js";
import { sendAiText } from "./telegramAdapter.js";

export const CHINESE_CONVERSATION_COMMAND_PATTERN =
  /^#?(?:(?:AI|ai)帮助|(?:强制)?停止(?:生成)?|清空全部对话|清空所有用户对话|清空对话[\s\S]*|(?:撤销|回滚|撤回|回退)对话[\s\S]*|篡改对话[\s\S]*|(?:列出|查看)对话[\s\S]*)$/;

export const CHINESE_CONVERSATION_HELP = [
  "中文对话指令：",
  "#停止 / #强制停止 — 停止当前生成",
  "#清空对话<前缀> — 清空该前缀所属设定的历史",
  "#撤回对话<前缀> [轮数] — 默认撤回最后 1 轮",
  "#回退对话<前缀> [轮数] — 与撤回对话相同",
  "#篡改对话<前缀> [序号] <新内容> — 修改某条 AI 回复",
  "#列出对话<前缀> — 查看当前短期对话",
  "#清空全部对话 — 清空自己在当前会话的全部前缀历史",
  "#清空所有用户对话 — 清空全体历史，仅主人可用",
  "",
  "轮数为正数时从末尾撤回，为负数时从开头删除。",
  "篡改序号 1 表示最后一条 AI 回复，-1 表示第一条。",
].join("\n");

export function parseChineseConversationCommand(text) {
  const input = String(text || "").trim();
  if (!CHINESE_CONVERSATION_COMMAND_PATTERN.test(input)) return null;

  if (/^#?(?:AI|ai)帮助$/.test(input)) return { type: "help", args: "" };
  if (/^#?(?:强制)?停止(?:生成)?$/.test(input)) {
    return { type: "stop", args: "" };
  }
  if (/^#?清空所有用户对话$/.test(input)) {
    return { type: "clear-everyone", args: "" };
  }
  if (/^#?清空全部对话$/.test(input)) {
    return { type: "clear-all", args: "" };
  }

  const commandPatterns = [
    ["clear", /^#?清空对话\s*([\s\S]*)$/],
    ["rollback", /^#?(?:撤销|回滚|撤回|回退)对话\s*([\s\S]*)$/],
    ["tamper", /^#?篡改对话\s*([\s\S]*)$/],
    ["list", /^#?(?:列出|查看)对话\s*([\s\S]*)$/],
  ];
  for (const [type, pattern] of commandPatterns) {
    const matched = pattern.exec(input);
    if (matched) return { type, args: String(matched[1] || "").trim() };
  }
  return null;
}

function profilePrefixes(profile) {
  return [...new Set(getProfilePrefixes(profile))]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
}

function enabledPrefixCandidates(profiles) {
  return (Array.isArray(profiles) ? profiles : [])
    .filter((profile) => profile?.enabled !== false)
    .flatMap((profile, profileIndex) =>
      profilePrefixes(profile).map((prefix, prefixIndex) => ({
        profile,
        prefix,
        profileIndex,
        prefixIndex,
      }))
    )
    .sort(
      (a, b) =>
        b.prefix.length - a.prefix.length ||
        a.profileIndex - b.profileIndex ||
        a.prefixIndex - b.prefixIndex
    );
}

export function consumeConversationPrefix(profiles, input) {
  const value = String(input || "").trim();
  for (const candidate of enabledPrefixCandidates(profiles)) {
    if (value === candidate.prefix) {
      return { profile: candidate.profile, rest: "" };
    }
    if (
      value.startsWith(candidate.prefix) &&
      /^\s/.test(value.slice(candidate.prefix.length, candidate.prefix.length + 1))
    ) {
      return {
        profile: candidate.profile,
        rest: value.slice(candidate.prefix.length).trim(),
      };
    }
  }
  return null;
}

function resolveWholePrefix(profiles, input) {
  const value = String(input || "").trim();
  if (!value) return null;
  const consumed = consumeConversationPrefix(profiles, value);
  return consumed?.rest === "" ? consumed.profile : null;
}

export function rollbackConversationHistory(history, rounds = 1) {
  const amount = Math.trunc(Number(rounds));
  if (!Number.isFinite(amount) || amount === 0) {
    return { status: "invalid", history: [...(history || [])] };
  }

  const grouped = groupConversationRounds(history);
  const totalRounds = grouped.length;
  if (totalRounds === 0) {
    return { status: "empty", history: [], totalRounds: 0 };
  }

  const requestedRounds = Math.abs(amount);
  const removedRounds = Math.min(requestedRounds, totalRounds);
  const deleteFromFront = amount < 0;
  const keptRounds = deleteFromFront
    ? grouped.slice(removedRounds)
    : grouped.slice(0, totalRounds - removedRounds);
  return {
    status: "ok",
    history: keptRounds.flat(),
    totalRounds,
    requestedRounds,
    removedRounds,
    remainingRounds: totalRounds - removedRounds,
    deleteFromFront,
  };
}

function historyItemText(item) {
  return (item?.parts || [])
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text)
    .join("");
}

export function tamperConversationHistory(history, index, newContent) {
  const position = Math.trunc(Number(index));
  const replacement = String(newContent || "").trim();
  if (!Number.isFinite(position) || position === 0 || !replacement) {
    return { status: "invalid", history: [...(history || [])] };
  }

  const nextHistory = [...(Array.isArray(history) ? history : [])];
  const modelIndices = nextHistory
    .map((item, itemIndex) => (item?.role === "model" ? itemIndex : -1))
    .filter((itemIndex) => itemIndex >= 0);
  if (modelIndices.length === 0) {
    return { status: "empty", history: nextHistory, modelCount: 0 };
  }

  const modelPosition =
    position > 0 ? modelIndices.length - position : Math.abs(position) - 1;
  if (modelPosition < 0 || modelPosition >= modelIndices.length) {
    return {
      status: "out-of-range",
      history: nextHistory,
      modelCount: modelIndices.length,
    };
  }

  const targetIndex = modelIndices[modelPosition];
  const oldText = historyItemText(nextHistory[targetIndex]);
  nextHistory[targetIndex] = {
    role: "model",
    parts: [{ text: replacement }],
  };
  return {
    status: "ok",
    history: nextHistory,
    modelCount: modelIndices.length,
    oldText,
    newText: replacement,
    index: position,
  };
}

function profileName(profile) {
  return profile?.name || getPrimaryPrefix(profile) || "默认角色";
}

function historyName(profile) {
  return getPrimaryPrefix(profile) || profileName(profile);
}

function visibleHistoryItemText(item) {
  return historyItemText(item);
}

function preview(value, maxLength = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function formatConversationList(history, profile) {
  const rounds = groupConversationRounds(history);
  const sections = rounds.map((round, roundIndex) => {
    const messages = round
      .map((item) => {
        const text = visibleHistoryItemText(item);
        if (!text) return "";
        const role = item.role === "user" ? "你" : profileName(profile);
        return `${role}：\n${text}`;
      })
      .filter(Boolean);
    return [`【第 ${roundIndex + 1} 轮】`, ...messages].join("\n");
  });
  return [
    `「${profileName(profile)}」对话历史（共 ${rounds.length} 轮）`,
    ...sections,
  ].join("\n\n");
}

function resolveRollbackTarget(profiles, rawArgs) {
  const args = String(rawArgs || "").trim();
  if (!args) return null;

  const consumed = consumeConversationPrefix(profiles, args);
  if (consumed) {
    if (!consumed.rest) return { profile: consumed.profile, rounds: 1 };
    if (/^-?\d+$/.test(consumed.rest)) {
      return { profile: consumed.profile, rounds: Number(consumed.rest) };
    }
    return null;
  }
  return null;
}

function resolveTamperTarget(profiles, rawArgs) {
  const consumed = consumeConversationPrefix(profiles, rawArgs);
  if (!consumed?.profile || !consumed.rest) return null;

  const indexed = /^(-?\d+)\s+([\s\S]+)$/.exec(consumed.rest);
  if (!indexed) {
    return {
      profile: consumed.profile,
      index: 1,
      newContent: consumed.rest,
    };
  }
  return {
    profile: consumed.profile,
    index: Number(indexed[1]),
    newContent: indexed[2].trim(),
  };
}

export async function handleChineseConversationCommand(ctx, {
  profiles = [],
  isBusy = () => false,
} = {}) {
  const command = parseChineseConversationCommand(ctx?.message?.text);
  if (!command) return false;

  if (command.type === "help") {
    await ctx.reply(CHINESE_CONVERSATION_HELP);
    return true;
  }
  if (command.type === "stop") {
    await ctx.reply(
      requestStopCurrentTasks(ctx)
        ? "已请求停止当前 AI 任务。"
        : "当前没有运行中的 AI 任务。"
    );
    return true;
  }
  if (isBusy(ctx)) {
    await ctx.reply("当前 AI 请求仍在处理中，请先发送 #停止，等待任务结束后再管理对话。");
    return true;
  }

  if (command.type === "clear-everyone") {
    if (!ctx.isMaster) {
      await ctx.reply("该指令仅主人可用。");
      return true;
    }
    const count = await clearAllConversationHistories();
    await ctx.reply(`已清空所有用户的全部对话历史（${count} 项）。`);
    return true;
  }
  if (command.type === "clear-all") {
    const count = await clearAllProfilesForUser(ctx);
    await ctx.reply(`已清空你在当前会话中的全部前缀对话（${count} 项）。`);
    return true;
  }

  if (command.type === "clear" || command.type === "list") {
    const profile = resolveWholePrefix(profiles, command.args);
    if (!profile) {
      if (!command.args) {
        await ctx.reply(
          command.type === "clear"
            ? "用法：#清空对话<前缀>"
            : "用法：#列出对话<前缀>"
        );
      } else {
        await ctx.reply(`未找到前缀「${command.args}」，请检查输入。`);
      }
      return true;
    }
    const storedHistoryName = historyName(profile);
    if (command.type === "clear") {
      await clearConversationHistory(ctx, storedHistoryName);
      await ctx.reply(`你与「${profileName(profile)}」的对话历史已清空。`);
      return true;
    }

    const history = await loadConversationHistory(ctx, storedHistoryName);
    if (history.length === 0) {
      await ctx.reply(`目前没有与「${profileName(profile)}」的对话历史。`);
      return true;
    }
    await sendAiText(ctx, formatConversationList(history, profile));
    return true;
  }

  if (command.type === "rollback") {
    const target = resolveRollbackTarget(profiles, command.args);
    if (!target?.profile) {
      await ctx.reply("用法：#撤回对话<前缀> [轮数]");
      return true;
    }
    if (target.rounds === 0) {
      await ctx.reply("操作轮数不能为 0。");
      return true;
    }

    const storedHistoryName = historyName(target.profile);
    const history = await loadConversationHistory(ctx, storedHistoryName);
    const result = rollbackConversationHistory(history, target.rounds);
    if (result.status === "empty") {
      await ctx.reply(`目前没有与「${profileName(target.profile)}」的对话历史。`);
      return true;
    }
    if (result.status !== "ok") {
      await ctx.reply("操作轮数必须是非零整数。");
      return true;
    }

    if (result.history.length === 0) {
      await clearConversationHistory(ctx, storedHistoryName);
    } else {
      await saveConversationHistory(ctx, result.history, storedHistoryName);
    }
    const direction = result.deleteFromFront ? "开头" : "末尾";
    await ctx.reply(
      `已从「${profileName(target.profile)}」对话${direction}删除 ${result.removedRounds} 轮，当前剩余 ${result.remainingRounds} 轮。`
    );
    return true;
  }

  if (command.type === "tamper") {
    const target = resolveTamperTarget(profiles, command.args);
    if (!target?.profile || !target.newContent) {
      await ctx.reply("用法：#篡改对话<前缀> [序号] <新内容>");
      return true;
    }
    if (target.index === 0) {
      await ctx.reply("篡改序号不能为 0。");
      return true;
    }

    const storedHistoryName = historyName(target.profile);
    const history = await loadConversationHistory(ctx, storedHistoryName);
    const result = tamperConversationHistory(
      history,
      target.index,
      target.newContent
    );
    if (result.status === "empty") {
      await ctx.reply(`目前没有与「${profileName(target.profile)}」的 AI 回复记录。`);
      return true;
    }
    if (result.status === "out-of-range") {
      await ctx.reply(`序号超出范围，目前共有 ${result.modelCount} 条 AI 回复。`);
      return true;
    }
    if (result.status !== "ok") {
      await ctx.reply("篡改序号必须是非零整数，并且新内容不能为空。");
      return true;
    }

    await saveConversationHistory(ctx, result.history, storedHistoryName);
    const direction = target.index > 0
      ? `倒数第 ${target.index}`
      : `正数第 ${Math.abs(target.index)}`;
    await ctx.reply(
      `已篡改「${profileName(target.profile)}」${direction} 条 AI 回复。\n` +
      `原内容：${preview(result.oldText || "（无内容）")}\n` +
      `新内容：${preview(result.newText)}`
    );
    return true;
  }

  return false;
}
