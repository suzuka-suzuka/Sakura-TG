/** The one setup command kept outside roleplay and NovelAI. */
export default {
  name: "identity",

  register(bot) {
    bot.command("id", async (ctx) => {
      await ctx.reply(
        [
          `你的 ID: ${ctx.from?.id}`,
          `会话 ID: ${ctx.chat?.id}`,
          `会话类型: ${ctx.chat?.type}`,
          `权限: ${ctx.isMaster ? "主人" : ctx.isWhite ? "白名单" : "普通"}`,
        ].join("\n")
      );
    });
  },
};
