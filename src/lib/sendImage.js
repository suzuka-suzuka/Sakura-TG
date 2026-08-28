import { InputFile } from "grammy";
import Config from "../config.js";
import { logger } from "../logger.js";

const MB = 1024 * 1024;
const DEFAULT_PHOTO_UPLOAD_LIMIT = 10 * MB;
const DEFAULT_FILE_UPLOAD_LIMIT = 50 * MB;
const LOCAL_UPLOAD_LIMIT = 2000 * MB;

function uploadLimit() {
  return Config.get("telegram.localApiServer")
    ? LOCAL_UPLOAD_LIMIT
    : DEFAULT_FILE_UPLOAD_LIMIT;
}

function photoUploadLimit() {
  return Config.get("telegram.localApiServer")
    ? LOCAL_UPLOAD_LIMIT
    : DEFAULT_PHOTO_UPLOAD_LIMIT;
}

/** Send an in-memory NovelAI result as a photo, falling back to a document. */
export async function sendImageBuffer(ctx, buffer, options = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const {
    caption,
    parse_mode,
    reply_markup,
    filename = "novelai.png",
    mode = "auto",
  } = options;
  const extra = { caption, parse_mode, reply_markup };

  if (bytes.length === 0) {
    return { ok: false, size: 0, reason: "empty" };
  }
  if (bytes.length > uploadLimit()) {
    return { ok: false, size: bytes.length, reason: "exceeds-limit" };
  }

  if (mode !== "document" && bytes.length <= photoUploadLimit()) {
    try {
      await ctx.replyWithPhoto(new InputFile(bytes, filename), extra);
      return { ok: true, method: "photo-upload", size: bytes.length };
    } catch (error) {
      logger.warn(
        `[sendImageBuffer] 图片发送失败，改用文件: ${
          error?.description || error?.message || error
        }`
      );
      if (mode === "photo") {
        return { ok: false, size: bytes.length, reason: "send-failed" };
      }
    }
  }

  try {
    await ctx.replyWithDocument(new InputFile(bytes, filename), extra);
    return { ok: true, method: "document-upload", size: bytes.length };
  } catch (error) {
    logger.error(
      `[sendImageBuffer] 文件发送失败: ${
        error?.description || error?.message || error
      }`
    );
    return { ok: false, size: bytes.length, reason: "send-failed" };
  }
}
