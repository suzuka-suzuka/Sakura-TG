import fs from "node:fs";
import path from "node:path";
import Config from "../config.js";
import { logger } from "../logger.js";
import {
  isTelegramHtmlParseError,
  renderTelegramHtmlChunks,
} from "./telegramHtml.js";

function isGroup(chat) {
  return chat?.type === "group" || chat?.type === "supergroup";
}

export function attachAiContextAliases(ctx) {
  ctx.user_id = ctx.from?.id;
  ctx.group_id = isGroup(ctx.chat) ? ctx.chat.id : null;
  ctx.self_id = ctx.me?.id;
  return ctx;
}

function mediaFile(message) {
  if (message?.photo?.length) {
    const item = message.photo.at(-1);
    return {
      fileId: item.file_id,
      fileSize: item.file_size,
      mimeType: "image/jpeg",
      fileName: `telegram-${item.file_unique_id || item.file_id}.jpg`,
    };
  }
  if (message?.document?.mime_type?.startsWith("image/")) {
    return {
      fileId: message.document.file_id,
      fileSize: message.document.file_size,
      mimeType: message.document.mime_type,
      fileName: message.document.file_name || "telegram-image",
    };
  }
  if (message?.sticker && !message.sticker.is_animated && !message.sticker.is_video) {
    return {
      fileId: message.sticker.file_id,
      fileSize: message.sticker.file_size,
      mimeType: "image/webp",
      fileName: `sticker-${message.sticker.file_unique_id}.webp`,
    };
  }
  return null;
}

async function readResponseCapped(response, cap) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error("图片超过输入体积限制");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > cap) throw new Error("图片超过输入体积限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function downloadTelegramFile(ctx, item, remainingBytes) {
  if (item.fileSize && item.fileSize > remainingBytes) {
    throw new Error("图片超过输入体积限制");
  }
  const file = await ctx.api.getFile(item.fileId);
  if (!file.file_path) throw new Error("Telegram 未返回文件路径");

  if (path.isAbsolute(file.file_path) && fs.existsSync(file.file_path)) {
    const stat = fs.statSync(file.file_path);
    if (stat.size > remainingBytes) {
      throw new Error("图片超过输入体积限制");
    }
    return fs.promises.readFile(file.file_path);
  }

  const telegram = Config.get("telegram");
  const apiRoot = String(telegram.apiRoot || "https://api.telegram.org")
    .replace(/\/+$/, "");
  const url = `${apiRoot}/file/bot${telegram.token}/${file.file_path}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Telegram 文件下载失败：HTTP ${response.status}`);
  }
  return readResponseCapped(response, remainingBytes);
}

/** Read images only from the current Telegram message and its explicit reply. */
export async function collectTelegramImages(
  ctx,
  { includeReply = true } = {}
) {
  const visionConfig = Config.get("ai.nativeVision") || {};
  const maxImages = visionConfig.maxImages ?? 4;
  const maxBytes = visionConfig.maxBytes || 20 * 1024 * 1024;
  const candidates = [
    mediaFile(ctx.message),
    ...(includeReply ? [mediaFile(ctx.message?.reply_to_message)] : []),
  ].filter((item) => item?.mimeType?.startsWith("image/"));
  const seen = new Set();
  const images = [];
  let usedBytes = 0;

  for (const item of candidates) {
    if (images.length >= maxImages || seen.has(item.fileId)) continue;
    seen.add(item.fileId);
    const buffer = await downloadTelegramFile(
      ctx,
      item,
      maxBytes - usedBytes
    );
    usedBytes += buffer.length;
    images.push({
      buffer,
      base64: buffer.toString("base64"),
      mimeType: item.mimeType,
      fileName: item.fileName,
    });
  }
  return images;
}

export function repliedMessageText(ctx) {
  const message = ctx.message?.reply_to_message;
  if (!message) return "";
  const sender =
    [message.from?.first_name, message.from?.last_name]
      .filter(Boolean)
      .join(" ") ||
    message.from?.username ||
    message.from?.id ||
    "未知用户";
  const text = String(message.text || message.caption || "").trim();
  const media = mediaFile(message) ? "[图片]" : "";
  const content = [media, text].filter(Boolean).join(" ");
  return content ? `${sender}：${content}` : "";
}

export function splitTelegramText(text, maxLength = 3900) {
  const normalized = String(text || "");
  if (normalized.length <= maxLength) return normalized ? [normalized] : [];
  const chunks = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < maxLength * 0.5) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < maxLength * 0.5) cut = maxLength;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function sendAiText(ctx, text) {
  const chunks = renderTelegramHtmlChunks(text);
  const sent = [];
  for (const chunk of chunks) {
    let message;
    try {
      message = await ctx.reply(chunk.html, { parse_mode: "HTML" });
    } catch (error) {
      if (!isTelegramHtmlParseError(error)) throw error;
      logger.warn(
        `[AI] Telegram HTML 解析失败，已降级为纯文本: ${error.message}`
      );
      message = await ctx.reply(chunk.raw);
    }
    sent.push(message);
  }
  return sent;
}

export async function withChatAction(ctx, action, task) {
  const send = () => ctx.replyWithChatAction(action).catch(() => {});
  await send();
  const timer = setInterval(send, 4000);
  timer.unref?.();
  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}
