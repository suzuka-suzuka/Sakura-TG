import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { ConfigSchema, getDefaultConfig } from "./configSchema.js";
import { ensureChatDrawCharacterTagRule } from "./ai/chatDrawTags.js";
import { logger, setLogLevel } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, "../config");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.yaml");
const EXAMPLE_PATH = path.join(CONFIG_DIR, "config.example.yaml");

function roundNovelAIDimension(value, fallback) {
  const number = Number(value);
  const resolved = Number.isFinite(number) && number > 0 ? number : fallback;
  return Math.max(64, Math.min(2048, Math.round(resolved / 64) * 64));
}

function migrateLegacyChatDrawDimensions(channel, aspectRatio) {
  const baseWidth = roundNovelAIDimension(channel?.width, 832);
  const baseHeight = roundNovelAIDimension(channel?.height, 1216);
  const [ratioWidth, ratioHeight] = String(aspectRatio || "")
    .split(":")
    .map(Number);
  if (!(ratioWidth > 0 && ratioHeight > 0)) {
    return { width: baseWidth, height: baseHeight };
  }

  const ratio = ratioWidth / ratioHeight;
  const area = baseWidth * baseHeight;
  return {
    width: roundNovelAIDimension(Math.sqrt(area * ratio), baseWidth),
    height: roundNovelAIDimension(Math.sqrt(area / ratio), baseHeight),
  };
}

function pick(obj, key) {
  return key.split(".").reduce((acc, part) => acc?.[part], obj);
}

function dump(data) {
  return yaml.dump(data, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    quotingType: "'",
  });
}

function atomicWrite(filePath, contents) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tempPath, contents, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

export function migrateLegacyAiConfig(rawConfig) {
  const next = structuredClone(rawConfig || {});
  delete next.loliImage;

  const ai = next.ai;
  if (!ai || typeof ai !== "object" || Array.isArray(ai)) return next;

  const hasPrompt = (value) => Boolean(String(value || "").trim());
  const legacyRoles = Array.isArray(ai.roles) ? ai.roles : [];
  const legacyRolePrompts = new Map();
  for (const role of legacyRoles) {
    const name = String(role?.name || "").trim();
    if (!name) continue;
    const prompt = String(role?.prompt || "");
    if (
      !legacyRolePrompts.has(name) ||
      (!hasPrompt(legacyRolePrompts.get(name)) && hasPrompt(prompt))
    ) {
      legacyRolePrompts.set(name, prompt);
    }
  }

  const hasExplicitRoleCards = Array.isArray(ai.roleCards);
  const roleCards = hasExplicitRoleCards ? ai.roleCards : [];
  const roleCardsByName = new Map();
  for (const roleCard of roleCards) {
    const name = String(roleCard?.name || "").trim();
    if (name && !roleCardsByName.has(name)) {
      roleCardsByName.set(name, roleCard);
    }
  }

  if (Array.isArray(ai.profiles)) {
    for (const profile of ai.profiles) {
      const name = String(profile?.name || "").trim();
      const hasLegacyProfilePrompt = Object.hasOwn(profile || {}, "prompt");
      const profilePrompt = String(profile?.prompt || "");
      const legacyPrompt = legacyRolePrompts.get(name) || "";
      let roleCard = roleCardsByName.get(name);

      if (
        name &&
        !roleCard &&
        (!hasExplicitRoleCards ||
          hasLegacyProfilePrompt ||
          legacyRolePrompts.has(name))
      ) {
        roleCard = {
          name,
          prompt: hasPrompt(profilePrompt) ? profilePrompt : legacyPrompt,
        };
        roleCards.push(roleCard);
        roleCardsByName.set(name, roleCard);
      } else if (
        roleCard &&
        !hasPrompt(roleCard.prompt) &&
        (hasPrompt(profilePrompt) || hasPrompt(legacyPrompt))
      ) {
        roleCard.prompt = hasPrompt(profilePrompt)
          ? profilePrompt
          : legacyPrompt;
      }

      delete profile.prompt;
      delete profile.promptAddons;
      delete profile.groupContext;
      delete profile.toolGroup;
      delete profile.naiChannel;
    }
  }

  for (const role of legacyRoles) {
    const name = String(role?.name || "").trim();
    if (!name || roleCardsByName.has(name)) continue;
    const roleCard = { name, prompt: String(role?.prompt || "") };
    roleCards.push(roleCard);
    roleCardsByName.set(name, roleCard);
  }
  ai.roleCards = roleCards;

  if (Array.isArray(ai.routes)) {
    for (const route of ai.routes) {
      for (const target of Array.isArray(route?.targets) ? route.targets : []) {
        delete target.supportsImages;
        delete target.nativeWebSearch;
      }
    }
  }

  const legacyImage =
    ai.image && typeof ai.image === "object" && !Array.isArray(ai.image)
      ? ai.image
      : {};
  const existingVision =
    ai.nativeVision && typeof ai.nativeVision === "object"
      ? ai.nativeVision
      : {};
  ai.nativeVision = {
    maxImages: existingVision.maxImages ?? legacyImage.maxInputImages ?? 4,
    maxBytes:
      existingVision.maxBytes ??
      legacyImage.maxInputBytes ??
      20 * 1024 * 1024,
  };

  const oldNovelAIChannels = Array.isArray(legacyImage.channels?.novelai)
    ? legacyImage.channels.novelai
    : [];
  const existingNovelAI =
    ai.novelAI && typeof ai.novelAI === "object" && !Array.isArray(ai.novelAI)
      ? ai.novelAI
      : {};
  const existingLegacyChannels = Array.isArray(existingNovelAI.channels)
    ? existingNovelAI.channels
    : [];
  const legacyChannels =
    existingLegacyChannels.length > 0
      ? existingLegacyChannels
      : oldNovelAIChannels;
  const preferredLegacyChannel = String(
    existingNovelAI.defaultChannel || legacyImage.defaultChannel || ""
  ).trim();
  const selectedLegacyChannel =
    legacyChannels.find(
      (channel) => channel?.name === preferredLegacyChannel
    ) ||
    legacyChannels[0] ||
    {};
  const novelAIValue = (key) =>
    Object.hasOwn(existingNovelAI, key)
      ? existingNovelAI[key]
      : selectedLegacyChannel[key];
  const hasExistingWidth = Object.hasOwn(
    existingNovelAI,
    "chatDrawWidth"
  );
  const hasExistingHeight = Object.hasOwn(
    existingNovelAI,
    "chatDrawHeight"
  );
  const hasLegacyWidth = Object.hasOwn(legacyImage, "chatDrawWidth");
  const hasLegacyHeight = Object.hasOwn(legacyImage, "chatDrawHeight");
  let chatDrawWidth = hasExistingWidth
    ? existingNovelAI.chatDrawWidth
    : legacyImage.chatDrawWidth;
  let chatDrawHeight = hasExistingHeight
    ? existingNovelAI.chatDrawHeight
    : legacyImage.chatDrawHeight;

  if (
    !hasExistingWidth &&
    !hasExistingHeight &&
    !hasLegacyWidth &&
    !hasLegacyHeight
  ) {
    const hasExistingAspectRatio = Object.hasOwn(
      existingNovelAI,
      "chatDrawAspectRatio"
    );
    const aspectRatio = hasExistingAspectRatio
      ? existingNovelAI.chatDrawAspectRatio
      : legacyImage.chatDrawAspectRatio;
    if (aspectRatio !== undefined) {
      const migratedDimensions = migrateLegacyChatDrawDimensions(
        {
          width: novelAIValue("width"),
          height: novelAIValue("height"),
        },
        aspectRatio
      );
      chatDrawWidth = migratedDimensions.width;
      chatDrawHeight = migratedDimensions.height;
    }
  }
  ai.novelAI = {
    enabled: existingNovelAI.enabled ?? legacyImage.enabled ?? true,
    model: novelAIValue("model"),
    baseURL: novelAIValue("baseURL"),
    api: novelAIValue("api"),
    checkV5Usage: novelAIValue("checkV5Usage"),
    negative: novelAIValue("negative"),
    qualityTags: novelAIValue("qualityTags"),
    width: novelAIValue("width"),
    height: novelAIValue("height"),
    scale: novelAIValue("scale"),
    steps: novelAIValue("steps"),
    sampler: novelAIValue("sampler"),
    strength: novelAIValue("strength"),
    noise: novelAIValue("noise"),
    chatDrawPrompt: ensureChatDrawCharacterTagRule(
      existingNovelAI.chatDrawPrompt ?? legacyImage.chatDrawPrompt
    ),
    chatDrawWidth,
    chatDrawHeight,
    chatDrawCount:
      existingNovelAI.chatDrawCount ?? legacyImage.chatDrawCount,
  };
  for (const [key, value] of Object.entries(ai.novelAI)) {
    if (value === undefined) delete ai.novelAI[key];
  }

  for (const key of [
    "roles",
    "toolsEnabled",
    "toolGroups",
    "toolsRoute",
    "groupContextLength",
    "groupMessageMaxCount",
    "groupMessageTtlSeconds",
    "maxToolCalls",
    "trustAICommand",
    "image",
    "video",
    "mcp",
    "memory",
  ]) {
    delete ai[key];
  }
  return next;
}

// 改动后需要重启进程才生效的字段：只在启动时用过一次，热重载碰不到
export const RESTART_REQUIRED = [
  "telegram.token",
  "telegram.apiRoot",
  "telegram.dropPendingUpdates",
  "redis",
  "web.enabled",
  "web.host",
  "web.port",
];

export class ConfigManager {
  constructor() {
    this.config = getDefaultConfig();
    this._watcher = null;
    this._listeners = new Set();
    this.load();
  }

  load() {
    if (!fs.existsSync(CONFIG_PATH)) {
      // 首次启动：从默认值生成一份，用户填 token 即可
      atomicWrite(CONFIG_PATH, dump(getDefaultConfig()));
      logger.warn(`[Config] 已生成默认配置: ${CONFIG_PATH}`);
    }

    let raw;
    try {
      raw = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8")) || {};
    } catch (e) {
      logger.error(`[Config] 配置文件解析失败: ${e.message}`);
      throw e;
    }

    const sourceRaw = raw;
    raw = migrateLegacyAiConfig(raw);
    const result = ConfigSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        logger.error(`[Config] ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      throw new Error("配置校验失败，请修正 config/config.yaml");
    }

    this.config = result.data;
    setLogLevel(this.config.logLevel);

    // 补齐新增字段后回写，schema 加字段时用户无需手动同步
    const normalized = dump(this.config);
    if (normalized !== dump(sourceRaw)) {
      atomicWrite(CONFIG_PATH, normalized);
      logger.info("[Config] 已补全缺失字段");
    }

    return this.config;
  }

  /**
   * 监听配置文件改动并热重载。
   *
   * node --watch 只跟踪被 import 的 JS 模块，不管运行时用 fs 读的文件，
   * 所以 config.yaml 得自己看着。
   *
   * 监听的是目录而不是文件本身 —— 编辑器多用"写临时文件再改名"的原子保存，
   * 直接 watch 文件会在第一次保存后就失去目标。
   */
  watch() {
    if (this._watcher) return;

    let timer;
    this._watcher = fs.watch(CONFIG_DIR, (_event, filename) => {
      if (filename !== "config.yaml") return;

      // fs.watch 在 Windows 上一次保存常触发多个事件，去抖
      clearTimeout(timer);
      timer = setTimeout(() => this._reload(), 200);
    });

    logger.info("[Config] 已开启配置热重载");
  }

  _reload() {
    const before = this.config;

    try {
      this.load();
    } catch (e) {
      // load() 只在校验通过后才赋值，所以旧配置仍然完好
      logger.error(`[Config] 重载失败，继续沿用旧配置: ${e.message}`);
      return;
    }

    if (JSON.stringify(before) === JSON.stringify(this.config)) return;

    const stale = this.getRestartRequiredChanges(before, this.config);

    logger.info("[Config] 配置已重载");
    if (stale.length > 0) {
      logger.warn(`[Config] ${stale.join("、")} 需要重启进程才会生效`);
    }

    this._emitChange(this.config, before, stale);
  }

  /** 注册配置变更回调，返回取消函数 */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  unwatch() {
    this._watcher?.close();
    this._watcher = null;
  }

  get(key) {
    if (!key) return this.config;
    return key.split(".").reduce((acc, part) => acc?.[part], this.config);
  }

  getRestartRequiredChanges(before, after) {
    return RESTART_REQUIRED.filter(
      (key) =>
        JSON.stringify(pick(after, key)) !== JSON.stringify(pick(before, key))
    );
  }

  /**
   * 校验并原子保存整份配置。返回已经过 schema 补全的配置以及需要重启的字段。
   * Web 面板与后续其他写入入口统一走这里，避免绕过真实运行时 schema。
   */
  save(raw) {
    const result = ConfigSchema.safeParse(migrateLegacyAiConfig(raw));
    if (!result.success) {
      const error = new Error("配置校验失败");
      error.name = "ConfigValidationError";
      error.issues = result.error.issues;
      throw error;
    }

    const before = this.config;
    const next = result.data;
    const stale = this.getRestartRequiredChanges(before, next);

    atomicWrite(CONFIG_PATH, dump(next));
    this.config = next;
    setLogLevel(next.logLevel);
    this._emitChange(next, before, stale);

    return {
      config: next,
      restartRequired: stale,
    };
  }

  _emitChange(next, before, restartRequired = []) {
    for (const fn of this._listeners) {
      try {
        fn(next, {
          previous: before,
          restartRequired,
        });
      } catch (e) {
        logger.error(`[Config] 重载回调执行失败: ${e.message}`);
      }
    }
  }

  get path() {
    return CONFIG_PATH;
  }

  /** 写出一份 example，供入库参考（真实配置不入库） */
  writeExample() {
    atomicWrite(EXAMPLE_PATH, dump(getDefaultConfig()));
  }
}

export default new ConfigManager();
