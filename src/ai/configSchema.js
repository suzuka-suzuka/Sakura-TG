import { z } from "zod";
import { DEFAULT_CHAT_DRAW_PROMPT } from "./chatDrawTags.js";
import {
  DEFAULT_NOVELAI_MODEL,
  DEFAULT_NOVELAI_NEGATIVE,
  DEFAULT_NOVELAI_QUALITY_TAGS,
} from "./media/novelAIProvider.js";

const nonEmptyString = (label) =>
  z.string().trim().min(1, `${label}不能为空`);

const SchedulingStrategySchema = z
  .enum([
    "round_robin",
    "weighted_round_robin",
    "priority",
    "priority_weighted",
  ])
  .default("priority_weighted");

const CredentialSchema = z.object({
  id: nonEmptyString("凭据 ID"),
  apiKey: z.string().trim().default(""),
  serviceAccountRef: z.string().trim().default(""),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  weight: z.number().int().min(1).max(100).default(1),
});

const ProviderSchema = z
  .object({
    id: nonEmptyString("供应商 ID"),
    protocol: z.enum(["openai", "gemini"]).default("openai"),
    baseURL: z.string().trim().default(""),
    vertex: z.boolean().default(false),
    credentials: z.array(CredentialSchema).min(1, "至少配置一个凭据"),
  })
  .superRefine((provider, ctx) => {
    const ids = new Set();
    provider.credentials.forEach((credential, index) => {
      if (ids.has(credential.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["credentials", index, "id"],
          message: `凭据 ID “${credential.id}”重复`,
        });
      }
      ids.add(credential.id);

      if (credential.enabled === false) return;
      const usesVertex =
        provider.protocol === "gemini" && provider.vertex === true;
      const required = usesVertex
        ? credential.serviceAccountRef
        : credential.apiKey;
      if (!required) {
        ctx.addIssue({
          code: "custom",
          path: [
            "credentials",
            index,
            usesVertex ? "serviceAccountRef" : "apiKey",
          ],
          message: usesVertex
            ? "Vertex 凭据需要 serviceAccountRef"
            : "启用的凭据需要 API Key",
        });
      }
    });

    if (provider.vertex && provider.protocol !== "gemini") {
      ctx.addIssue({
        code: "custom",
        path: ["vertex"],
        message: "Vertex 只能用于 Gemini 协议",
      });
    }
  });

const RouteTargetSchema = z.object({
  id: nonEmptyString("目标 ID"),
  provider: nonEmptyString("供应商 ID"),
  model: nonEmptyString("模型"),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  weight: z.number().int().min(1).max(100).default(1),
  temperatureOverride: z.number().min(-1).max(2).default(-1),
  topPOverride: z.number().min(-1).max(1).default(-1),
  openaiEnableThinking: z.boolean().default(false),
  openaiReasoningEffort: z
    .enum([
      "inherit",
      "default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    .default("inherit"),
  geminiThinkingLevel: z
    .enum([
      "inherit",
      "default",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ])
    .default("inherit"),
  geminiThinkingBudget: z.number().int().min(-2).default(-2),
});

const RouteSchema = z
  .object({
    id: nonEmptyString("路由 ID"),
    strategy: SchedulingStrategySchema,
    temperature: z.number().min(-1).max(2).default(-1),
    topP: z.number().min(-1).max(1).default(-1),
    reasoningLevel: z
      .enum(["default", "off", "minimal", "low", "medium", "high"])
      .default("default"),
    maxAttempts: z.number().int().min(1).max(50).default(3),
    retryDelayMs: z.number().int().min(0).max(60_000).default(1000),
    targets: z.array(RouteTargetSchema).min(1, "至少配置一个路由目标"),
  })
  .superRefine((route, ctx) => {
    const ids = new Set();
    route.targets.forEach((target, index) => {
      if (ids.has(target.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", index, "id"],
          message: `目标 ID “${target.id}”重复`,
        });
      }
      ids.add(target.id);
    });
  });

const RoleCardSchema = z.object({
  name: nonEmptyString("角色卡名字"),
  prompt: z.string().default(""),
});

const ProfileSchema = z.object({
  name: nonEmptyString("角色卡"),
  prefixes: z.array(nonEmptyString("触发前缀")).default([]),
  keepTriggerPrefix: z.boolean().default(false),
  route: nonEmptyString("模型路由"),
  history: z.boolean().default(true),
  enableNaiPainting: z.boolean().default(false),
  naiPrompt: z.string().default(""),
  enabled: z.boolean().default(true),
});

const NativeVisionSchema = z.object({
  maxImages: z.number().int().min(0).max(10).default(4),
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(100 * 1024 * 1024)
    .default(20 * 1024 * 1024),
});

const NovelAIDimensionSchema = z
  .number()
  .int()
  .min(64)
  .max(2048)
  .refine((value) => value % 64 === 0, "尺寸必须是 64 的倍数");

const NovelAISchema = z.object({
  enabled: z.boolean().default(true),
  model: nonEmptyString("生图模型").default(DEFAULT_NOVELAI_MODEL),
  baseURL: z.string().trim().default("https://image.novelai.net"),
  api: z.string().trim().default(""),
  checkV5Usage: z.boolean().default(true),
  negative: z.string().default(DEFAULT_NOVELAI_NEGATIVE),
  qualityTags: z.string().default(DEFAULT_NOVELAI_QUALITY_TAGS),
  width: NovelAIDimensionSchema.default(832),
  height: NovelAIDimensionSchema.default(1216),
  scale: z.number().min(0).max(10).nullable().default(null),
  steps: z.number().int().min(1).max(50).default(28),
  sampler: z.string().trim().min(1).default("k_euler_ancestral"),
  strength: z.number().min(0).max(1).default(0.7),
  noise: z.number().min(0).max(1).default(0),
  chatDrawPrompt: z.string().default(DEFAULT_CHAT_DRAW_PROMPT),
  chatDrawWidth: NovelAIDimensionSchema.default(1216),
  chatDrawHeight: NovelAIDimensionSchema.default(832),
  chatDrawCount: z.number().int().min(1).max(4).default(1),
});

export const AISchema = z
  .object({
    enabled: z.boolean().default(true),
    privateAutoReply: z.boolean().default(false),
    defaultProfile: z.string().trim().default(""),
    roleCards: z.array(RoleCardSchema).default([]),
    profiles: z.array(ProfileSchema).default([]),
    providers: z.array(ProviderSchema).default([]),
    routes: z.array(RouteSchema).default([]),
    chatHistoryLength: z.number().int().min(0).max(100).default(20),
    historyTtlSeconds: z
      .number()
      .int()
      .min(3600)
      .max(90 * 24 * 60 * 60)
      .default(7 * 24 * 60 * 60),
    enableUserLock: z.boolean().default(true),
    requestTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(30 * 60 * 1000)
      .default(120_000),
    nativeVision: NativeVisionSchema.default(() =>
      NativeVisionSchema.parse({})
    ),
    novelAI: NovelAISchema.default(() => NovelAISchema.parse({})),
  })
  .superRefine((config, ctx) => {
    for (const [field, items] of [
      ["providers", config.providers],
      ["routes", config.routes],
      ["roleCards", config.roleCards],
      ["profiles", config.profiles],
    ]) {
      const seen = new Set();
      items.forEach((item, index) => {
        const value = item.id || item.name;
        if (seen.has(value)) {
          ctx.addIssue({
            code: "custom",
            path: [...field.split("."), index, item.id ? "id" : "name"],
            message: `${item.id ? "ID" : "名称"}重复`,
          });
        }
        seen.add(value);
      });
    }

    const prefixes = new Set();
    config.profiles.forEach((profile, profileIndex) => {
      profile.prefixes.forEach((prefix, prefixIndex) => {
        if (prefixes.has(prefix)) {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", profileIndex, "prefixes", prefixIndex],
            message: `触发前缀“${prefix}”重复`,
          });
        }
        prefixes.add(prefix);
      });
    });

    const providerIds = new Set(config.providers.map((item) => item.id));
    const routeIds = new Set(config.routes.map((item) => item.id));
    const roleCardNames = new Set(config.roleCards.map((item) => item.name));
    const profileNames = new Set(config.profiles.map((item) => item.name));

    config.routes.forEach((route, routeIndex) => {
      route.targets.forEach((target, targetIndex) => {
        if (!providerIds.has(target.provider)) {
          ctx.addIssue({
            code: "custom",
            path: [
              "routes",
              routeIndex,
              "targets",
              targetIndex,
              "provider",
            ],
            message: `供应商“${target.provider}”不存在`,
          });
        }
      });
    });

    config.profiles.forEach((profile, profileIndex) => {
      if (!roleCardNames.has(profile.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles", profileIndex, "name"],
          message: `角色卡“${profile.name}”不存在`,
        });
      }
      if (!routeIds.has(profile.route)) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles", profileIndex, "route"],
          message: `路由“${profile.route}”不存在`,
        });
      }
    });

    if (config.defaultProfile && !profileNames.has(config.defaultProfile)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultProfile"],
        message: `默认角色“${config.defaultProfile}”不存在`,
      });
    }
  });
