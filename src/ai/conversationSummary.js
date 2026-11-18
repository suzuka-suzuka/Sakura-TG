import Config from "../config.js";
import { logger } from "../logger.js";
import { parseChatDrawTags } from "./chatDrawTags.js";
import {
  groupConversationRounds,
  loadConversationHistory,
  loadConversationSummary,
  saveConversationHistory,
  saveConversationSummary,
} from "./conversationHistory.js";
import { getAI } from "./getAI.js";
import { DEFAULT_HISTORY_SUMMARY_PROMPT } from "./historySummaryPrompt.js";

const SUMMARY_MAX_LENGTH = 8000;

const defaultStore = {
  loadHistory: loadConversationHistory,
  saveHistory: saveConversationHistory,
  loadSummary: loadConversationSummary,
  saveSummary: saveConversationSummary,
};

/**
 * Decide which rounds to fold into the summary. Nothing happens until the
 * history passes `maxRounds`; then everything except the newest
 * `keepRounds` (at most maxRounds - 1) is compressed in one batch, so the
 * extra model call happens once every few turns rather than every turn.
 */
export function planHistoryCompression(history, { maxRounds, keepRounds }) {
  const limit = Math.floor(Number(maxRounds) || 0);
  if (limit <= 0) return null;
  const rounds = groupConversationRounds(history);
  if (rounds.length <= limit) return null;
  const keep = Math.min(
    Math.max(0, Math.floor(Number(keepRounds) || 0)),
    limit - 1
  );
  const compressCount = rounds.length - keep;
  return {
    compressRounds: rounds.slice(0, compressCount),
    keptRounds: rounds.slice(compressCount),
  };
}

function cleanSummary(text) {
  const visible = parseChatDrawTags(text).text.trim();
  return visible.length > SUMMARY_MAX_LENGTH
    ? visible.slice(0, SUMMARY_MAX_LENGTH).trimEnd()
    : visible;
}

/**
 * Compress the oldest rounds of one conversation into its 前情提要.
 *
 * The request reuses the conversation's own system prompt (built from the
 * current summary by `buildSystemPrompt`), replays the rounds being
 * compressed as ordinary history, and appends the compression instruction as
 * the last user message. The summary is saved before the rounds are removed,
 * and nothing is written if the history changed while the model was working.
 */
export async function compressConversationHistory({
  ctx,
  historyName,
  route,
  buildSystemPrompt,
  aiConfig = Config.get("ai") || {},
  requestModel = getAI,
  store = defaultStore,
  log = logger,
}) {
  const settings = aiConfig.historySummary || {};
  if (settings.enabled === false) return { status: "disabled" };

  const history = await store.loadHistory(ctx, historyName);
  const plan = planHistoryCompression(history, {
    maxRounds: aiConfig.chatHistoryLength ?? 20,
    keepRounds: settings.keepRounds ?? 10,
  });
  if (!plan) return { status: "skipped" };

  const previousSummary = await store.loadSummary(ctx, historyName);
  const instruction = String(
    settings.prompt || DEFAULT_HISTORY_SUMMARY_PROMPT
  ).trim();
  const response = await requestModel(
    route,
    ctx,
    [{ text: instruction }],
    buildSystemPrompt(previousSummary),
    plan.compressRounds.flat()
  );
  if (typeof response === "string") {
    log.warn(`[History Summary] 压缩失败，保留原始历史: ${response}`);
    return { status: "failed", error: response };
  }
  const summary = cleanSummary(response?.text);
  if (!summary) {
    log.warn("[History Summary] 模型没有返回前情提要，保留原始历史");
    return { status: "failed", error: "empty summary" };
  }

  const latestRounds = groupConversationRounds(
    await store.loadHistory(ctx, historyName)
  );
  const compressedPrefix = latestRounds.slice(0, plan.compressRounds.length);
  if (
    JSON.stringify(compressedPrefix) !== JSON.stringify(plan.compressRounds)
  ) {
    log.info("[History Summary] 历史已在压缩期间变化，跳过本次写入");
    return { status: "stale" };
  }

  const remaining = latestRounds.slice(plan.compressRounds.length);
  await store.saveSummary(ctx, summary, historyName);
  await store.saveHistory(ctx, remaining.flat(), historyName);
  log.info(
    `[History Summary] 已压缩 ${plan.compressRounds.length} 轮为前情提要，保留 ${remaining.length} 轮原文`
  );
  return {
    status: "compressed",
    summary,
    compressedRounds: plan.compressRounds.length,
    remainingRounds: remaining.length,
  };
}
