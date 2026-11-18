import { createHash } from "node:crypto";
import Config from "../config.js";
import { logger } from "../logger.js";
import { getRedis } from "../redis.js";

const KEY_PREFIX = "sakuratg:ai:conversation:v1";
const SUMMARY_KEY_PREFIX = "sakuratg:ai:conversation-summary:v1";

function contextIds(ctx) {
  return {
    chatId: String(ctx?.chat?.id ?? ctx?.group_id ?? "private"),
    userId: String(ctx?.from?.id ?? ctx?.user_id ?? "unknown"),
  };
}

function profileKey(profileName) {
  return createHash("sha256")
    .update(String(profileName || "default"))
    .digest("hex")
    .slice(0, 24);
}

export function getConversationHistoryKey(ctx, profileName) {
  const { chatId, userId } = contextIds(ctx);
  return `${KEY_PREFIX}:${chatId}:${userId}:${profileKey(profileName)}`;
}

/**
 * The Redis history is intentionally text-only. This also migrates old stored
 * tool exchanges and Base64 image parts by dropping non-text payloads. Textual
 * model metadata such as hidden <draw> tags remains part of conversation context.
 */
export function sanitizeConversationHistory(history = []) {
  if (!Array.isArray(history)) return [];
  return history.flatMap((item) => {
    if (!item || !["user", "model"].includes(item.role)) return [];
    const parts = (Array.isArray(item.parts) ? item.parts : [])
      .filter(
        (part) =>
          typeof part?.text === "string" && part.thought !== true
      )
      .map((part) => ({ text: part.text }));
    return parts.length > 0 ? [{ role: item.role, parts }] : [];
  });
}

export function groupConversationRounds(history = []) {
  if (!Array.isArray(history)) return [];
  const rounds = [];
  let current = [];
  for (const item of history) {
    if (!item) continue;
    if (item.role === "user") {
      if (current.length > 0) rounds.push(current);
      current = [item];
    } else if (current.length > 0) {
      current.push(item);
    }
  }
  if (current.length > 0) rounds.push(current);
  return rounds;
}

export function trimConversationHistoryByRounds(
  history = [],
  maxRounds = 20
) {
  const limit = Math.max(0, Math.floor(Number(maxRounds) || 0));
  return (limit > 0
    ? groupConversationRounds(history).slice(-limit)
    : []
  ).flat();
}

function historyTtlSeconds(aiConfig) {
  return aiConfig.historyTtlSeconds || 7 * 24 * 60 * 60;
}

/**
 * Rounds kept in Redis. With summaries on, rounds past chatHistoryLength wait
 * for compression instead of being dropped; twice the limit is a backstop in
 * case compression keeps failing.
 */
export function getStoredHistoryRoundLimit(aiConfig = Config.get("ai") || {}) {
  const limit = Math.max(
    0,
    Math.floor(Number(aiConfig.chatHistoryLength ?? 20) || 0)
  );
  return limit > 0 && aiConfig.historySummary?.enabled !== false
    ? limit * 2
    : limit;
}

export async function loadConversationHistory(
  ctx,
  profileName,
  { redis = null } = {}
) {
  const client = redis || getRedis();
  const key = getConversationHistoryKey(ctx, profileName);
  const payload = await client.get(key);
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload);
    const history = sanitizeConversationHistory(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(history)) {
      await saveConversationHistory(ctx, history, profileName, {
        redis: client,
      });
      logger.info(
        `[ConversationHistory] 已迁移为纯文本历史: ${profileName}`
      );
    }
    return history;
  } catch (error) {
    logger.warn(
      `[ConversationHistory] 历史解析失败，已清除: ${error.message}`
    );
    await client.del(key);
    return [];
  }
}

export async function saveConversationHistory(
  ctx,
  currentHistory,
  profileName,
  { redis = null } = {}
) {
  const client = redis || getRedis();
  const aiConfig = Config.get("ai") || {};
  const trimmed = trimConversationHistoryByRounds(
    sanitizeConversationHistory(currentHistory),
    getStoredHistoryRoundLimit(aiConfig)
  );
  if (Array.isArray(currentHistory)) {
    currentHistory.splice(0, currentHistory.length, ...trimmed);
  }

  const key = getConversationHistoryKey(ctx, profileName);
  if (trimmed.length === 0) {
    await client.del(key);
    return;
  }
  const ttl = historyTtlSeconds(aiConfig);
  await client.set(key, JSON.stringify(trimmed), "EX", ttl);
  // Keep the summary alive exactly as long as the rounds it precedes.
  await client.expire?.(getConversationSummaryKey(ctx, profileName), ttl);
}

export function getConversationSummaryKey(ctx, profileName) {
  const { chatId, userId } = contextIds(ctx);
  return `${SUMMARY_KEY_PREFIX}:${chatId}:${userId}:${profileKey(profileName)}`;
}

/** The compressed 前情提要 for rounds that no longer exist verbatim. */
export async function loadConversationSummary(
  ctx,
  profileName,
  { redis = null } = {}
) {
  const client = redis || getRedis();
  const payload = await client.get(getConversationSummaryKey(ctx, profileName));
  if (!payload) return "";
  try {
    const parsed = JSON.parse(payload);
    return String(parsed?.text ?? "").trim();
  } catch {
    return String(payload).trim();
  }
}

export async function saveConversationSummary(
  ctx,
  summary,
  profileName,
  { redis = null } = {}
) {
  const client = redis || getRedis();
  const key = getConversationSummaryKey(ctx, profileName);
  const text = String(summary || "").trim();
  if (!text) {
    await client.del(key);
    return;
  }
  await client.set(
    key,
    JSON.stringify({ text, updatedAt: Date.now() }),
    "EX",
    historyTtlSeconds(Config.get("ai") || {})
  );
}

/** Clear a profile's rounds and its summary. */
export async function clearConversationHistory(ctx, profileName) {
  return getRedis().del(
    getConversationHistoryKey(ctx, profileName),
    getConversationSummaryKey(ctx, profileName)
  );
}

async function clearConversationKeys(pattern) {
  let cursor = "0";
  let deleted = 0;
  do {
    const [nextCursor, keys] = await getRedis().scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100
    );
    cursor = nextCursor;
    if (keys.length > 0) deleted += await getRedis().del(...keys);
  } while (cursor !== "0");
  return deleted;
}

/** Returns the number of cleared histories; their summaries go with them. */
export async function clearAllProfilesForUser(ctx) {
  const { chatId, userId } = contextIds(ctx);
  const deleted = await clearConversationKeys(
    `${KEY_PREFIX}:${chatId}:${userId}:*`
  );
  await clearConversationKeys(`${SUMMARY_KEY_PREFIX}:${chatId}:${userId}:*`);
  return deleted;
}

export async function clearAllConversationHistories() {
  const deleted = await clearConversationKeys(`${KEY_PREFIX}:*`);
  await clearConversationKeys(`${SUMMARY_KEY_PREFIX}:*`);
  return deleted;
}

const conversationQueues = new Map();

/**
 * Run tasks for one conversation key one at a time, so a background history
 * compression and the next chat turn never read and write the same rounds
 * concurrently.
 */
export function runConversationExclusive(key, task) {
  const previous = conversationQueues.get(key) || Promise.resolve();
  const run = previous.then(() => task());
  const tail = run.catch(() => {});
  conversationQueues.set(key, tail);
  void tail.then(() => {
    if (conversationQueues.get(key) === tail) conversationQueues.delete(key);
  });
  return run;
}
