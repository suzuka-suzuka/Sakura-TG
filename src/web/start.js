import Config from "../config.js";
import { logger } from "../logger.js";
import { startConfigServer } from "./configServer.js";

let control;
let closing = false;

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info(`[ConfigWeb] 收到 ${signal}，正在关闭...`);
  Config.unwatch();
  await control?.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  control = await startConfigServer({ force: true });
  Config.watch();
} catch (error) {
  logger.error(`[ConfigWeb] 启动失败: ${error.message}`);
  process.exitCode = 1;
}
