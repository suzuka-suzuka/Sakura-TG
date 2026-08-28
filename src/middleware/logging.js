import { logger } from "../logger.js";

function describeChat(chat) {
  if (!chat) return "未知会话";
  if (chat.type === "private") return "私聊";
  return `${chat.title || "群组"}(${chat.id})`;
}

function describeUser(from) {
  if (!from) return "未知用户";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return `${name || from.username || "匿名"}(${from.id})`;
}

/** 摘出一条可读的消息描述，媒体类消息标注类型 */
function describeMessage(msg) {
  if (!msg) return "";
  if (msg.text) return msg.text;
  if (msg.caption) return `[附件] ${msg.caption}`;
  if (msg.photo) return "[图片]";
  if (msg.sticker) return "[贴纸]";
  if (msg.voice) return "[语音]";
  if (msg.video) return "[视频]";
  if (msg.document) return "[文件]";
  return "[其他]";
}

export function installLogging(bot) {
  bot.use(async (ctx, next) => {
    const started = Date.now();

    if (ctx.message) {
      let text = describeMessage(ctx.message);
      if (text.length > 200) text = `${text.slice(0, 200)}...`;
      logger.info(`${describeChat(ctx.chat)} ${describeUser(ctx.from)}: ${text}`);
    } else if (ctx.callbackQuery) {
      logger.info(
        `${describeChat(ctx.chat)} ${describeUser(ctx.from)} 点击按钮: ${ctx.callbackQuery.data}`
      );
    }

    await next();

    const cost = Date.now() - started;
    if (cost > 3000) {
      logger.debug(`处理耗时 ${cost}ms`);
    }
  });
}
