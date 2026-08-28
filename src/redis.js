import { Redis } from "ioredis";
import Config from "./config.js";
import { logger } from "./logger.js";
import { ensureRedisServer } from "./redisServer.js";

let redisInstance = null;

/**
 * 导出名与 Sakura 的 src/utils/redis.js 一致（connectRedis / getRedis），
 * 从那边搬过来的模块只需改 import 路径。
 */
export async function connectRedis() {
  const cfg = Config.get("redis");

  await ensureRedisServer(cfg);
  logger.info(`[Redis] 正在连接 ${cfg.host}:${cfg.port} (db ${cfg.db})...`);

  const client = new Redis({
    host: cfg.host,
    port: cfg.port,
    password: cfg.password || undefined,
    db: cfg.db ?? 1,
    lazyConnect: true,
  });

  const onError = (err) => {
    logger.error(`[Redis] 运行时错误: ${err.message}`);
  };
  client.on("error", onError);

  try {
    await client.connect();
  } catch (error) {
    client.removeListener("error", onError);
    client.disconnect();
    throw error;
  }
  logger.info("[Redis] 连接成功");

  redisInstance = client;
  globalThis.redis = client;
  return client;
}

export function getRedis() {
  if (!redisInstance) {
    throw new Error("Redis 尚未初始化，请先调用 connectRedis()");
  }
  return redisInstance;
}

export async function closeRedis() {
  if (!redisInstance) return;
  await redisInstance.quit();
  redisInstance = null;
  globalThis.redis = null;
}
