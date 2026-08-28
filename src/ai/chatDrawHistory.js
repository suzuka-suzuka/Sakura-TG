import Config from "../config.js";
import { logger } from "../logger.js";
import { getRedis } from "../redis.js";

const KEY_PREFIX = "sakuratg:ai:last-chat-draw:v1";
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function contextIds(ctx) {
  return {
    chatId: String(ctx?.chat?.id ?? ctx?.group_id ?? "private"),
    userId: String(ctx?.from?.id ?? ctx?.user_id ?? "unknown"),
  };
}

function normalizeCenter(center) {
  const x = Number(center?.x);
  const y = Number(center?.y);
  return {
    x: Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5,
    y: Number.isFinite(y) ? Math.max(0, Math.min(1, y)) : 0.5,
  };
}

export function getLastChatDrawKey(ctx) {
  const { chatId, userId } = contextIds(ctx);
  return `${KEY_PREFIX}:${chatId}:${userId}`;
}

export function normalizeLastChatDrawRecord(record) {
  if (!record || typeof record !== "object") return null;
  const rawPrompt = String(record.rawPrompt || "").trim();
  const prompt = String(record.prompt || "").trim();
  const characters = (Array.isArray(record.characters) ? record.characters : [])
    .flatMap((character) => {
      const characterPrompt = String(character?.prompt || "").trim();
      if (!characterPrompt) return [];
      return [{
        prompt: characterPrompt,
        uc: String(character?.uc || "").trim(),
        center: normalizeCenter(character?.center),
        enabled: character?.enabled !== false,
      }];
    });
  if (!rawPrompt && !prompt && characters.length === 0) return null;
  return {
    profileName: String(record.profileName || "").trim(),
    rawPrompt,
    prompt,
    characters,
    createdAt: String(record.createdAt || new Date().toISOString()),
  };
}

export async function saveLastChatDraw(
  ctx,
  record,
  {
    redis = getRedis(),
    ttlSeconds = Config.get("ai.historyTtlSeconds") || DEFAULT_TTL_SECONDS,
  } = {}
) {
  const normalized = normalizeLastChatDrawRecord(record);
  if (!normalized) return null;
  await redis.set(
    getLastChatDrawKey(ctx),
    JSON.stringify(normalized),
    "EX",
    ttlSeconds
  );
  return normalized;
}

export async function loadLastChatDraw(ctx, { redis = getRedis() } = {}) {
  const key = getLastChatDrawKey(ctx);
  const payload = await redis.get(key);
  if (!payload) return null;
  try {
    const record = normalizeLastChatDrawRecord(JSON.parse(payload));
    if (record) return record;
  } catch (error) {
    logger.warn(`[ChatDrawHistory] 绘图标签记录解析失败: ${error.message}`);
  }
  await redis.del(key);
  return null;
}

function normalizeComparablePrompt(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, ", ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/^\s*,|,\s*$/g, "")
    .trim();
}

function percent(value) {
  return Number((Number(value) * 100).toFixed(1));
}

export function formatLastChatDraw(record) {
  const normalized = normalizeLastChatDrawRecord(record);
  if (!normalized) return "";
  const profileHint = normalized.profileName
    ? `（角色：${normalized.profileName}）`
    : "";
  const rawPrompt = normalized.rawPrompt || normalized.prompt;
  const lines = [
    `上一次 RP 绘图标签${profileHint}：`,
    `<draw>${rawPrompt}</draw>`,
  ];
  const showEffectivePrompt =
    normalized.characters.length > 0 ||
    normalizeComparablePrompt(rawPrompt) !== normalized.prompt;
  if (!showEffectivePrompt) return lines.join("\n");

  lines.push("", "实际提交给 NovelAI：");
  lines.push(`全局：${normalized.prompt || "（无全局提示词）"}`);
  normalized.characters.forEach((character, index) => {
    const position = `${percent(character.center.x)}%, ${percent(character.center.y)}%`;
    lines.push(`角色 ${index + 1}（${position}）：${character.prompt}`);
    if (character.uc) lines.push(`角色 ${index + 1} 负面：${character.uc}`);
  });
  return lines.join("\n");
}
