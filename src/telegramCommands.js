import { logger } from "./logger.js";

/**
 * Public commands advertised by Telegram when the user opens the slash menu.
 * Master-only maintenance commands remain executable but are intentionally
 * omitted from this global list.
 */
export const TELEGRAM_COMMAND_MENU = Object.freeze([
  Object.freeze({ command: "ai", description: "与指定角色进行对话" }),
  Object.freeze({ command: "nai", description: "使用 NovelAI 绘图" }),
  Object.freeze({
    command: "lastdraw",
    description: "查看上一次 RP 绘图标签",
  }),
  Object.freeze({ command: "vibes", description: "查看 NovelAI 画风列表" }),
  Object.freeze({ command: "stop", description: "停止当前生成任务" }),
  Object.freeze({ command: "forget", description: "清除短期对话历史" }),
  Object.freeze({
    command: "aihelp",
    description: "查看角色扮演与绘图帮助",
  }),
  Object.freeze({ command: "id", description: "查看自己的 Telegram ID" }),
]);

/**
 * Publish the slash-command list and restore Telegram's default commands menu
 * button. Failures are deliberately non-fatal so menu availability can never
 * prevent the bot itself from starting.
 */
export async function syncTelegramCommandMenu(bot, { log = logger } = {}) {
  let commandsSynced = false;
  let menuButtonSynced = false;

  try {
    await bot.api.setMyCommands(TELEGRAM_COMMAND_MENU);
    commandsSynced = true;
  } catch (error) {
    log.warn(`[Bot] Telegram 命令列表同步失败: ${error.message}`);
  }

  try {
    await bot.api.setChatMenuButton({
      menu_button: { type: "commands" },
    });
    menuButtonSynced = true;
  } catch (error) {
    log.warn(`[Bot] Telegram 命令菜单按钮同步失败: ${error.message}`);
  }

  if (commandsSynced && menuButtonSynced) {
    log.info(
      `[Bot] Telegram 命令菜单已同步（${TELEGRAM_COMMAND_MENU.length} 项）`
    );
  }
  return { commandsSynced, menuButtonSynced };
}
