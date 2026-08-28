import { Bot, GrammyError, HttpError } from "grammy";
import Config from "./config.js";
import { logger } from "./logger.js";
import { connectRedis, closeRedis } from "./redis.js";
import { installAuth } from "./middleware/auth.js";
import { installLogging } from "./middleware/logging.js";
import { modules } from "./modules/index.js";
import { syncTelegramCommandMenu } from "./telegramCommands.js";
import { startConfigServer } from "./web/configServer.js";

logger.info(logger.magenta("--------- SakuraTG 启动中 ---------"));

process.on("unhandledRejection", (reason) => {
  logger.error("[全局] 未处理的 Promise 拒绝:", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("[全局] 未捕获异常:", error);
});

let bot = null;
let configWeb = null;
let redisConnected = false;
let modulesInstalled = false;
let isShuttingDown = false;

async function gracefulShutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`收到 ${signal} 信号，正在关闭...`);

  try {
    if (bot?.isRunning()) await bot.stop();
    if (modulesInstalled) {
      for (const mod of [...modules].reverse()) {
        await mod.shutdown?.();
      }
    }
    if (redisConnected) await closeRedis();
    await configWeb?.close();
    Config.unwatch();
    logger.info("已安全退出");
  } catch (error) {
    logger.error(`关闭过程出错: ${error.message}`);
    exitCode = 1;
  }
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));

async function startWebPanel() {
  try {
    configWeb = await startConfigServer();
  } catch (error) {
    logger.error(`[ConfigWeb] 启动失败，Bot 将继续启动: ${error.message}`);
  }
}

async function startTelegramBot() {
  const tgConfig = Config.get("telegram");

  if (!tgConfig.token) {
    logger.error(
      "[启动] 未配置 Telegram Token，请通过配置面板或 config/config.yaml 填写"
    );
    if (configWeb) {
      logger.warn(
        `[启动] 当前仅运行配置面板；填写 Token 后请重启进程: ${configWeb.url}`
      );
      return;
    }
    process.exitCode = 1;
    return;
  }

  try {
    await connectRedis();
    redisConnected = true;
  } catch (error) {
    logger.error(`[启动] Redis 连接失败: ${error.message}`);
    if (configWeb) {
      logger.warn(
        `[启动] 当前仅运行配置面板；修正 Redis 后请重启进程: ${configWeb.url}`
      );
      return;
    }
    process.exitCode = 1;
    return;
  }

  bot = new Bot(tgConfig.token, {
    // 大陆直连 api.telegram.org 不通，apiRoot 指向自建 telegram-bot-api 或反代
    client: { apiRoot: tgConfig.apiRoot },
  });

  // 顺序有意义：日志在最外层记录所有更新，鉴权紧随其后拦掉不该处理的
  installLogging(bot);
  installAuth(bot);

  for (const mod of modules) {
    try {
      mod.installMiddleware?.(bot);
    } catch (error) {
      logger.error(`[模块] 中间件加载失败 ${mod.name}: ${error.message}`);
    }
  }

  for (const mod of modules) {
    try {
      mod.register(bot);
      logger.info(`[模块] 已加载: ${mod.name}`);
    } catch (error) {
      logger.error(`[模块] 加载失败 ${mod.name}: ${error.message}`);
    }
  }
  modulesInstalled = true;

  // bot.command() 只注册处理器；Telegram 客户端的 / 菜单需要通过
  // setMyCommands 单独发布。同步失败不会阻止后续长轮询启动。
  await syncTelegramCommandMenu(bot);

  // grammY 的兜底错误处理：单条更新出错不应拖垮长轮询
  bot.catch((error) => {
    const ctx = error.ctx;
    const where = `update ${ctx?.update?.update_id ?? "?"}`;

    if (error.error instanceof GrammyError) {
      logger.error(
        `[Bot] ${where} Telegram 接口报错: ${error.error.description}`
      );
    } else if (error.error instanceof HttpError) {
      logger.error(
        `[Bot] ${where} 网络不可达（检查 apiRoot / 代理）: ${error.error}`
      );
    } else {
      logger.error(`[Bot] ${where} 处理异常:`, error.error);
    }
  });

  // 长轮询无需公网 IP / webhook；网络不通时这里会抛 HttpError
  await bot.start({
    drop_pending_updates: tgConfig.dropPendingUpdates,
    onStart: (info) => {
      logger.info(
        logger.magenta(`--------- SakuraTG 已启动 @${info.username} ---------`)
      );
      if (tgConfig.masters.length === 0) {
        logger.warn(
          "[启动] 尚未配置主人，先私聊 bot 发送 /id 拿到数字 ID 再填进配置"
        );
      }
    },
  });
}

async function main() {
  await startWebPanel();

  // 权限、角色、模型路由和 NovelAI 等参数保存后热重载；
  // Token、Bot API、Redis 及面板监听设置会在界面中提示重启。
  Config.watch();
  await startTelegramBot();
}

try {
  await main();
} catch (error) {
  logger.error(`[启动] 未能启动 Bot: ${error.message}`);
  if (configWeb) {
    logger.warn(`[启动] 配置面板仍在运行，可修正配置后重启: ${configWeb.url}`);
  } else {
    await gracefulShutdown("启动失败", 1);
  }
}
