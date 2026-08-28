import { createHash } from "node:crypto";
import Config from "../config.js";
import { logger } from "../logger.js";
import { getRedis } from "../redis.js";

const KEY_PREFIX = "sakuratg:ai:conversation:v1";

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
 * tool exchanges and Base64 image parts by dropping everything except visible
 * user/model text.
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

export async function loadConversationHistory(ctx, profileName) {
  const redis = getRedis();
  const key = getConversationHistoryKey(ctx, profileName);
  const payload = await redis.get(key);
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload);
    const history = sanitizeConversationHistory(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(history)) {
      await saveConversationHistory(ctx, history, profileName);
      logger.info(
        `[ConversationHistory] 已迁移为纯文本历史: ${profileName}`
      );
    }
    return history;
  } catch (error) {
    logger.warn(
      `[ConversationHistory] 历史解析失败，已清除: ${error.message}`
    );
    await redis.del(key);
    return [];
  }
}

export async function saveConversationHistory(
  ctx,
  currentHistory,
  profileName
) {
  const aiConfig = Config.get("ai") || {};
  const trimmed = trimConversationHistoryByRounds(
    sanitizeConversationHistory(currentHistory),
    aiConfig.chatHistoryLength ?? 20
  );
  if (Array.isArray(currentHistory)) {
    currentHistory.splice(0, currentHistory.length, ...trimmed);
  }

  const key = getConversationHistoryKey(ctx, profileName);
  if (trimmed.length === 0) {
    await getRedis().del(key);
    return;
  }
  await getRedis().set(
    key,
    JSON.stringify(trimmed),
    "EX",
    aiConfig.historyTtlSeconds || 7 * 24 * 60 * 60
  );
}

export async function clearConversationHistory(ctx, profileName) {
  return getRedis().del(getConversationHistoryKey(ctx, profileName));
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

export async function clearAllProfilesForUser(ctx) {
  const { chatId, userId } = contextIds(ctx);
  return clearConversationKeys(`${KEY_PREFIX}:${chatId}:${userId}:*`);
}

export async function clearAllConversationHistories() {
  return clearConversationKeys(`${KEY_PREFIX}:*`);
}
