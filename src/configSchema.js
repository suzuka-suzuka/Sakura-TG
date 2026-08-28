import { z } from "zod";
import { AISchema } from "./ai/configSchema.js";

const TelegramSchema = z.object({
  token: z.string().default("").describe("BotFather 下发的 Bot Token"),
  apiRoot: z
    .string()
    .default("https://api.telegram.org")
    .describe("Bot API 地址，国内需指向自建反代"),
  masters: z.array(z.number()).default([]).describe("主人的 Telegram 数字 ID"),
  whiteUsers: z.array(z.number()).default([]).describe("白名单用户 ID"),
  whiteChats: z.array(z.number()).default([]).describe("会话白名单"),
  blackUsers: z.array(z.number()).default([]).describe("用户黑名单"),
  blockPrivate: z.boolean().default(false).describe("是否屏蔽私聊"),
  dropPendingUpdates: z
    .boolean()
    .default(true)
    .describe("启动时丢弃离线期间堆积的更新"),
  localApiServer: z
    .boolean()
    .default(false)
    .describe("是否使用自建 Telegram Bot API Server"),
});

const RedisSchema = z.object({
  host: z.string().default("127.0.0.1").describe("Redis 地址"),
  port: z.number().int().min(1).max(65535).default(6379).describe("Redis 端口"),
  password: z.string().default("").describe("Redis 密码"),
  execPath: z
    .string()
    .trim()
    .default("")
    .describe("本地 redis-server 程序或所在目录；留空时不自动启动"),
  db: z
    .number()
    .int()
    .min(0)
    .max(15)
    .default(1)
    .describe("Redis 数据库编号"),
});

const LOOPBACK_WEB_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const WebSchema = z
  .object({
    enabled: z.boolean().default(true).describe("是否启用配置面板"),
    host: z.string().trim().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(3457),
    password: z.string().default("").describe("面板登录密码"),
  })
  .superRefine((web, ctx) => {
    if (
      web.enabled &&
      !LOOPBACK_WEB_HOSTS.has(web.host.toLowerCase()) &&
      !web.password.trim()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["password"],
        message: "面板监听非本机地址时必须设置登录密码",
      });
    }
  });

export const ConfigSchema = z.object({
  logLevel: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
  telegram: TelegramSchema.default(() => TelegramSchema.parse({})),
  redis: RedisSchema.default(() => RedisSchema.parse({})),
  web: WebSchema.default(() => WebSchema.parse({})),
  ai: AISchema.default(() => AISchema.parse({})),
});

export function getDefaultConfig() {
  return ConfigSchema.parse({});
}
