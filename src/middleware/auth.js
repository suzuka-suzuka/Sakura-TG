import Config from "../config.js";

/**
 * 权限与准入。
 *
 * 在 ctx 上挂 isMaster / isWhite，并按黑白名单拦截。
 * 注意：Telegram 群的 chat.id 是负数（形如 -1001234567890），
 * 用户 id 是正数，两者不会混淆。
 */
export function installAuth(bot) {
  bot.use(async (ctx, next) => {
    const tg = Config.get("telegram");
    const userId = ctx.from?.id;
    const chat = ctx.chat;

    ctx.isMaster = userId != null && tg.masters.includes(userId);
    ctx.isWhite = ctx.isMaster || (userId != null && tg.whiteUsers.includes(userId));

    // 主人始终放行，避免把自己关在门外
    if (!ctx.isMaster) {
      if (userId != null && tg.blackUsers.includes(userId)) return;

      if (tg.blockPrivate && chat?.type === "private") return;

      if (tg.whiteChats.length > 0 && chat && !tg.whiteChats.includes(chat.id)) {
        return;
      }
    }

    await next();
  });
}

/** 仅主人可用的处理器包一层 */
export function masterOnly(handler) {
  return async (ctx, ...rest) => {
    if (!ctx.isMaster) return;
    return handler(ctx, ...rest);
  };
}

/** 主人 + 白名单可用 */
export function whiteOnly(handler) {
  return async (ctx, ...rest) => {
    if (!ctx.isWhite) return;
    return handler(ctx, ...rest);
  };
}
