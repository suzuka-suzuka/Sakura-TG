import { logger } from "../logger.js";
import { sendAiText } from "./telegramAdapter.js";
import {
  isTelegramHtmlParseError,
  renderTelegramHtml,
  renderTelegramHtmlChunks,
} from "./telegramHtml.js";

export const DEFAULT_STREAM_PRIVATE_INTERVAL_MS = 800;
export const DEFAULT_STREAM_GROUP_INTERVAL_MS = 2000;

// Telegram caps a message or draft at 4096 characters; while streaming only
// the tail of a long reply is shown and the full text is split on finish.
const PREVIEW_SOURCE_LIMIT = 3500;
const PREVIEW_HTML_LIMIT = 4000;
const MAX_DRAFT_ID = 2 ** 31 - 1;
const DEFAULT_RETRY_AFTER_MS = 3000;

/** Visible part of a partial reply: hide <draw> blocks, even half-written ones. */
export function streamingVisibleText(raw) {
  let text = String(raw || "").replace(
    /<draw(?:\s[^>]*)?>[\s\S]*?<\/draw\s*>/gi,
    ""
  );
  const openTag = text.search(/<draw(?=[\s>]|$)/i);
  if (openTag >= 0) text = text.slice(0, openTag);
  text = text.replace(/<(?:d(?:r(?:a(?:w)?)?)?)?$/i, "");
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function previewSource(visible) {
  if (visible.length <= PREVIEW_SOURCE_LIMIT) return visible;
  let tail = visible.slice(-PREVIEW_SOURCE_LIMIT);
  const lineBreak = tail.indexOf("\n");
  if (lineBreak >= 0 && lineBreak < 400) tail = tail.slice(lineBreak + 1);
  return `…\n${tail}`;
}

/** Render the in-progress text; `html` is null when it would be too long. */
export function renderStreamPreview(visible) {
  const raw = previewSource(String(visible || ""));
  const html = renderTelegramHtml(raw);
  return { raw, html: html.length <= PREVIEW_HTML_LIMIT ? html : null };
}

function telegramErrorText(error) {
  return String(error?.description || error?.message || error || "");
}

function retryAfterMs(error) {
  const limited =
    error?.error_code === 429 ||
    /too many requests/i.test(telegramErrorText(error));
  if (!limited) return 0;
  const seconds = Number(error?.parameters?.retry_after);
  return Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : DEFAULT_RETRY_AFTER_MS;
}

function isNotModifiedError(error) {
  return /message is not modified/i.test(telegramErrorText(error));
}

/**
 * Show a model reply while it is generated. Private chats stream into a
 * Telegram message draft (sendMessageDraft); groups, and private chats whose
 * Bot API rejects drafts, send one message and keep editing it. Updates are
 * throttled per mode and pause for Telegram's retry_after on HTTP 429.
 *
 * `finish(text)` delivers the final visible text as normal messages (reusing
 * the edited message when there is one); `close()` discards the preview.
 */
export function createTelegramStreamPresenter(
  ctx,
  {
    privateIntervalMs = DEFAULT_STREAM_PRIVATE_INTERVAL_MS,
    groupIntervalMs = DEFAULT_STREAM_GROUP_INTERVAL_MS,
    onFirstDisplay = null,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = logger,
  } = {}
) {
  const chatId = ctx?.chat?.id;
  const threadOptions =
    ctx?.msg?.is_topic_message && ctx.msg.message_thread_id
      ? { message_thread_id: ctx.msg.message_thread_id }
      : {};
  const draftId = 1 + Math.floor(Math.random() * (MAX_DRAFT_ID - 1));

  let mode = ctx?.chat?.type === "private" ? "draft" : "edit";
  let latestRaw = "";
  let shownText = "";
  // Exact HTML last written to the edited message (null after a plain-text
  // fallback), so finish() can skip an edit Telegram would reject as
  // "message is not modified".
  let shownHtml = null;
  let messageId = null;
  let updatesBroken = false;
  let displayed = false;
  let closed = false;
  let settled = false;
  let timer = null;
  let inflight = null;
  let lastFlushAt = now();
  let pausedUntil = 0;

  const intervalMs = () =>
    mode === "draft" ? privateIntervalMs : groupIntervalMs;

  function hasPendingText() {
    if (closed || updatesBroken) return false;
    // Empty text (e.g. a fallback attempt that has not produced visible
    // text yet) is never pending, or the timer would spin without flushing.
    const visible = streamingVisibleText(latestRaw);
    return Boolean(visible) && visible !== shownText;
  }

  function schedule() {
    if (closed || updatesBroken || timer || inflight) return;
    const wait = Math.max(
      0,
      lastFlushAt + intervalMs() - now(),
      pausedUntil - now()
    );
    timer = setTimer(() => {
      timer = null;
      inflight = flush().finally(() => {
        inflight = null;
        if (hasPendingText()) schedule();
      });
    }, wait);
    timer?.unref?.();
  }

  async function sendFormatted({ html, raw }) {
    if (html) {
      try {
        return await ctx.reply(html, { parse_mode: "HTML" });
      } catch (error) {
        if (!isTelegramHtmlParseError(error)) throw error;
      }
    }
    return ctx.reply(raw);
  }

  /** Returns the HTML that was applied, or null when plain text was used. */
  async function editFormatted(id, { html, raw }) {
    try {
      if (html) {
        try {
          await ctx.api.editMessageText(chatId, id, html, {
            parse_mode: "HTML",
          });
          return html;
        } catch (error) {
          if (!isTelegramHtmlParseError(error)) throw error;
        }
      }
      await ctx.api.editMessageText(chatId, id, raw);
    } catch (error) {
      if (!isNotModifiedError(error)) throw error;
    }
    return null;
  }

  async function pushDraft({ html, raw }) {
    if (html) {
      try {
        await ctx.api.sendMessageDraft(chatId, draftId, html, {
          ...threadOptions,
          parse_mode: "HTML",
        });
        return;
      } catch (error) {
        if (!isTelegramHtmlParseError(error)) throw error;
      }
    }
    await ctx.api.sendMessageDraft(chatId, draftId, raw, threadOptions);
  }

  async function pushEdit(preview) {
    if (messageId == null) {
      const message = await sendFormatted(preview);
      messageId = message?.message_id ?? null;
      if (messageId == null) updatesBroken = true;
      // The reply may have fallen back to plain text; only trust HTML that
      // an edit confirmed, so a first-message match always re-edits.
      shownHtml = null;
      return;
    }
    shownHtml = await editFormatted(messageId, preview);
  }

  function handleError(error) {
    const delay = retryAfterMs(error);
    if (delay > 0) {
      pausedUntil = now() + delay;
      return;
    }
    if (mode === "draft") {
      log.warn(
        `[AI Stream] 私聊草稿推送失败，改用编辑消息: ${telegramErrorText(error)}`
      );
      mode = "edit";
      lastFlushAt = now() - intervalMs();
      return;
    }
    log.warn(
      `[AI Stream] 流式消息更新失败，生成结束后再发送: ${telegramErrorText(error)}`
    );
    updatesBroken = true;
  }

  async function flush() {
    if (closed) return;
    const visible = streamingVisibleText(latestRaw);
    if (!visible || visible === shownText) return;
    lastFlushAt = now();
    try {
      const preview = renderStreamPreview(visible);
      if (mode === "draft") await pushDraft(preview);
      else await pushEdit(preview);
      shownText = visible;
      if (!displayed) {
        displayed = true;
        try {
          onFirstDisplay?.(mode);
        } catch (error) {
          log.warn(`[AI Stream] 首次显示回调失败: ${error?.message || error}`);
        }
      }
    } catch (error) {
      handleError(error);
    }
  }

  async function settle() {
    closed = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (inflight) await inflight.catch(() => {});
  }

  async function removeMessage() {
    if (messageId == null) return;
    const id = messageId;
    messageId = null;
    try {
      await ctx.api.deleteMessage(chatId, id);
    } catch (error) {
      log.warn(`[AI Stream] 删除流式消息失败: ${telegramErrorText(error)}`);
    }
  }

  return {
    get mode() {
      return mode;
    },

    /** Receive the accumulated raw model text; display is throttled. */
    update(raw) {
      if (closed) return;
      latestRaw = String(raw || "");
      if (hasPendingText()) schedule();
    },

    /** Deliver the final visible text and end the stream. */
    async finish(finalText) {
      if (settled) return [];
      settled = true;
      await settle();
      const text = String(finalText || "");

      if (messageId != null) {
        const chunks = updatesBroken ? [] : renderTelegramHtmlChunks(text);
        let edited = false;
        if (chunks.length > 0 && chunks[0].html === shownHtml) {
          edited = true;
        } else if (chunks.length > 0) {
          try {
            await editFormatted(messageId, chunks[0]);
            edited = true;
          } catch (error) {
            log.warn(
              `[AI Stream] 最终消息编辑失败，改为重新发送: ${telegramErrorText(error)}`
            );
          }
        }
        if (edited) {
          const sent = [{ message_id: messageId }];
          for (const chunk of chunks.slice(1)) {
            sent.push(await sendFormatted(chunk));
          }
          return sent;
        }
        await removeMessage();
      }
      return text ? sendAiText(ctx, text) : [];
    },

    /** Discard the preview (stop, error, or nothing visible to send). */
    async close() {
      if (settled) return;
      settled = true;
      await settle();
      await removeMessage();
    },
  };
}
