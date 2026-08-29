import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { logger } from "../../logger.js";

export const DEFAULT_NOVELAI_MODEL = "nai-diffusion-5-full";
export const DEFAULT_NOVELAI_NEGATIVE =
  "nsfw, lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page";
export const DEFAULT_NOVELAI_QUALITY_TAGS =
  "very aesthetic, masterpiece, no text";
export const NAI_IMAGE_RETRY_DELAYS_MS = [10_000, 20_000, 30_000];

const DEFAULT_STEPS = 28;
const NAI_USAGE_MIN_PERCENT = 5;
const NAI_USAGE_FALLBACK_COOLDOWN_SECONDS = 60;
const NAI_OPUS_TIER = 3;
const NAI_FREE_MAX_PIXELS = 1024 * 1024;
const NAI_FREE_MAX_STEPS = 28;
const MAX_ZIP_ENTRIES = 16;
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const MODEL_PROFILES = Object.freeze({
  v5: Object.freeze({
    family: "v5",
    paramsVersion: 4,
    scale: 7,
    steps: DEFAULT_STEPS,
    legacyUc: false,
    skipCfgAboveSigma: null,
    maxCharacters: 32,
    supportsVibe: false,
    characterPositionGrid: null,
  }),
  v45: Object.freeze({
    family: "v4.5",
    paramsVersion: 4,
    scale: 5,
    steps: DEFAULT_STEPS,
    legacyUc: false,
    skipCfgAboveSigma: null,
    maxCharacters: 6,
    supportsVibe: true,
    characterPositionGrid: 5,
  }),
  v4: Object.freeze({
    family: "v4",
    paramsVersion: 4,
    scale: 5.5,
    steps: DEFAULT_STEPS,
    legacyUc: true,
    skipCfgAboveSigma: null,
    maxCharacters: 6,
    supportsVibe: true,
    characterPositionGrid: 5,
  }),
  legacy: Object.freeze({
    family: "legacy",
    paramsVersion: 3,
    scale: 5,
    steps: DEFAULT_STEPS,
    legacyUc: false,
    skipCfgAboveSigma: 58,
    maxCharacters: null,
    supportsVibe: true,
    characterPositionGrid: null,
  }),
});

const VIBE_PARAMETER_KEYS = [
  "reference_image_multiple",
  "reference_information_extracted_multiple",
  "reference_strength_multiple",
];
const NAI_RETRYABLE_NETWORK_CODES = new Set([
  "ABORT_ERR",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ETIMEDOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_SOCKET",
]);
const NAI_RETRYABLE_NETWORK_MESSAGE =
  /(?:terminated|fetch failed|network error|socket hang up|timed?\s*out|timeout|connection (?:reset|refused|closed)|premature close|other side closed|econnreset|econnrefused|etimedout|eai_again|enotfound|网络(?:错误|异常|中断)|连接(?:重置|超时|中断|失败))/i;

function clampInteger(value, fallback, min, max) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number)
    ? Math.max(min, Math.min(max, number))
    : fallback;
}

function configuredNumber(value, fallback) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundDimension(value, fallback) {
  return Math.max(
    64,
    Math.min(2048, Math.round((Number(value) || fallback) / 64) * 64)
  );
}

function normalizePromptTag(tag) {
  return String(tag || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function configuredQualityTags(value) {
  return String(value ?? DEFAULT_NOVELAI_QUALITY_TAGS)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Append configured quality tags without duplicating managed tags. A visible
 * text request removes the managed `no text` tag and keeps a trailing Text:
 * block at the absolute end, matching NovelAI V5 prompt semantics.
 */
export function appendNovelAIQualityTags(
  prompt,
  qualityTags = DEFAULT_NOVELAI_QUALITY_TAGS
) {
  const input = String(prompt || "").trim();
  const textBlockIndex = input.search(/\bText\s*:/i);
  const visualPrompt = (textBlockIndex >= 0
    ? input.slice(0, textBlockIndex)
    : input
  ).replace(/[\s,]+$/g, "");
  const textBlock =
    textBlockIndex >= 0 ? input.slice(textBlockIndex).trim() : "";
  const visiblePromptWithoutNoText = visualPrompt.replace(
    /\bno\s+text\b/gi,
    ""
  );
  const hasVisibleTextIntent =
    Boolean(textBlock) ||
    /\b(?:english|japanese|chinese)?\s*text\b/i.test(
      visiblePromptWithoutNoText
    );
  const managedTags = configuredQualityTags(qualityTags);
  const managedByName = new Map(
    managedTags.map((tag) => [normalizePromptTag(tag), tag])
  );
  const promptParts = visualPrompt
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = [];
  const seenManaged = new Set();

  for (const part of promptParts) {
    const normalized = normalizePromptTag(part);
    if (managedByName.has(normalized)) {
      if (normalized === "no text" && hasVisibleTextIntent) continue;
      if (seenManaged.has(normalized)) continue;
      seenManaged.add(normalized);
    }
    merged.push(part);
  }

  for (const [normalized, original] of managedByName) {
    if (normalized === "no text" && hasVisibleTextIntent) continue;
    if (seenManaged.has(normalized)) continue;
    seenManaged.add(normalized);
    merged.push(original);
  }

  const mergedPrompt = merged.join(", ");
  return textBlock
    ? [mergedPrompt, textBlock].filter(Boolean).join("\n")
    : mergedPrompt;
}

export function wantsNovelAITransparentBackground(prompt) {
  return /\b(?:transparent background|has alpha|alpha transparency)\b/i.test(
    String(prompt || "")
  );
}

export function getNovelAIModelProfile(model = DEFAULT_NOVELAI_MODEL) {
  const modelName = String(model || DEFAULT_NOVELAI_MODEL).toLowerCase();
  if (modelName.startsWith("nai-diffusion-5-")) return MODEL_PROFILES.v5;
  if (modelName.startsWith("nai-diffusion-4-5-")) {
    return MODEL_PROFILES.v45;
  }
  if (modelName.startsWith("nai-diffusion-4-")) return MODEL_PROFILES.v4;
  return MODEL_PROFILES.legacy;
}

export function hasNovelAIVibeParameters(parameters) {
  return VIBE_PARAMETER_KEYS.some((key) => {
    const value = parameters?.[key];
    return Array.isArray(value) ? value.length > 0 : value != null;
  });
}

function normalizeCharacterCenter(center, profile) {
  const clamp = (value) =>
    Math.max(
      0,
      Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0.5)
    );
  const normalized = {
    x: clamp(center?.x),
    y: clamp(center?.y),
  };
  if (profile.characterPositionGrid !== 5) return normalized;

  const snapToFiveGrid = (value) =>
    (Math.min(4, Math.floor(value * 5)) * 2 + 1) / 10;
  return {
    x: snapToFiveGrid(normalized.x),
    y: snapToFiveGrid(normalized.y),
  };
}

export function getNovelAI45FallbackModel(model = DEFAULT_NOVELAI_MODEL) {
  return String(model).toLowerCase().includes("curated")
    ? "nai-diffusion-4-5-curated"
    : "nai-diffusion-4-5-full";
}

export function resolveNovelAIModelForRequest(
  model = DEFAULT_NOVELAI_MODEL,
  parameters = {}
) {
  if (
    getNovelAIModelProfile(model).family === "v5" &&
    hasNovelAIVibeParameters(parameters)
  ) {
    return getNovelAI45FallbackModel(model);
  }
  return model;
}

export function isNovelAI45ZeroAnlasGeneration(payload) {
  const parameters = payload?.parameters || {};
  const width = Number(parameters.width);
  const height = Number(parameters.height);
  const steps = Number(parameters.steps);
  const samples = Number(parameters.n_samples);
  return (
    payload?.action === "generate" &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width * height <= NAI_FREE_MAX_PIXELS &&
    Number.isFinite(steps) &&
    steps > 0 &&
    steps <= NAI_FREE_MAX_STEPS &&
    samples === 1
  );
}

export function canUseFreeNovelAI45Fallback(payload, usageLimitError) {
  return (
    usageLimitError?.code === "NAI_USAGE_LIMIT" &&
    Number(usageLimitError.subscriptionTier) === NAI_OPUS_TIER &&
    usageLimitError.subscriptionActive === true &&
    isNovelAI45ZeroAnlasGeneration(payload)
  );
}

export function buildNovelAIRequest({
  channel = {},
  prompt,
  source = null,
  model = null,
  negative = null,
  parameters = {},
  characters = [],
}) {
  const useModel = model || channel.model || DEFAULT_NOVELAI_MODEL;
  const profile = getNovelAIModelProfile(useModel);
  if (!profile.supportsVibe && hasNovelAIVibeParameters(parameters)) {
    throw new Error(
      "NovelAI V5 暂不支持画风（Vibe Transfer），请切换到 V4.5 模型后再使用"
    );
  }

  const useCharacters = Array.isArray(characters) ? characters : [];
  if (
    profile.maxCharacters != null &&
    useCharacters.length > profile.maxCharacters
  ) {
    throw new Error(
      `${profile.family} 模型最多支持 ${profile.maxCharacters} 个角色提示词`
    );
  }

  const positive = appendNovelAIQualityTags(prompt, channel.qualityTags);
  const useNegative = String(
    negative || channel.negative || DEFAULT_NOVELAI_NEGATIVE
  ).trim();
  const width = roundDimension(channel?.width, 832);
  const height = roundDimension(channel?.height, 1216);
  const modelWasOverridden =
    String(useModel).toLowerCase() !==
    String(channel.model || DEFAULT_NOVELAI_MODEL).toLowerCase();
  const useCoords = useCharacters.length > 0;
  const positionedCharacters = useCharacters.map((character) => ({
    ...character,
    center: normalizeCharacterCenter(character.center, profile),
  }));
  const characterPrompts = positionedCharacters.map((character) => ({
    prompt: character.prompt,
    uc: character.uc || "",
    center: character.center,
    enabled: character.enabled !== false,
  }));
  const v4CharCaptions = positionedCharacters.map((character) => ({
    char_caption: character.prompt,
    centers: [character.center],
  }));
  const v4NegativeCharCaptions = positionedCharacters.map((character) => ({
    char_caption: character.uc || "",
    centers: [character.center],
  }));

  const generationParameters = {
    params_version: profile.paramsVersion,
    width,
    height,
    scale: configuredNumber(
      modelWasOverridden ? null : channel.scale,
      profile.scale
    ),
    sampler: channel.sampler || "k_euler_ancestral",
    steps: clampInteger(channel.steps, profile.steps, 1, 50),
    seed: Math.floor(Math.random() * 4_294_967_296),
    n_samples: 1,
    autoSmea: false,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: true,
    cfg_rescale: 0,
    noise_schedule: "karras",
    legacy_v3_extend: false,
    use_coords: useCoords,
    legacy_uc: profile.legacyUc,
    normalize_reference_strength_multiple: true,
    inpaintImg2ImgStrength: 1,
    characterPrompts,
    v4_prompt: {
      caption: {
        base_caption: positive,
        char_captions: v4CharCaptions,
      },
      use_coords: useCoords,
      use_order: true,
    },
    v4_negative_prompt: {
      caption: {
        base_caption: useNegative,
        char_captions: v4NegativeCharCaptions,
      },
      legacy_uc: profile.legacyUc,
    },
    negative_prompt: useNegative,
    deliberate_euler_ancestral_bug: false,
    prefer_brownian: true,
    image_format: "png",
    ...(profile.skipCfgAboveSigma == null
      ? {}
      : { skip_cfg_above_sigma: profile.skipCfgAboveSigma }),
    ...(profile.family === "v5"
      ? {
          tag_hint_transparent_background:
            wantsNovelAITransparentBackground(prompt),
        }
      : {}),
    ...parameters,
  };

  generationParameters.params_version = profile.paramsVersion;
  // 配置多张时由队列任务串行拆分，单次 API 请求始终只生成一张。
  generationParameters.n_samples = 1;
  if (profile.family === "v5") {
    generationParameters.noise_schedule = "karras";
  }

  if (source?.buffer) {
    generationParameters.image = Buffer.from(source.buffer).toString("base64");
    generationParameters.strength = configuredNumber(
      parameters.strength,
      configuredNumber(channel.strength, 0.7)
    );
    generationParameters.noise = configuredNumber(
      parameters.noise,
      configuredNumber(channel.noise, 0)
    );
  }

  return {
    input: positive,
    model: useModel,
    action: source?.buffer ? "img2img" : "generate",
    parameters: generationParameters,
  };
}

function isImageBuffer(buffer) {
  return (
    (buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )) ||
    (buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff) ||
    (buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP")
  );
}

function findEndOfCentralDirectory(buffer) {
  const lowerBound = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lowerBound; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

export function extractNovelAIImages(buffer) {
  const archive = Buffer.from(buffer || []);
  if (isImageBuffer(archive)) return [archive];
  if (archive.length < 22) throw new Error("NovelAI 返回的图片压缩包无效");

  const eocdOffset = findEndOfCentralDirectory(archive);
  if (eocdOffset < 0) throw new Error("NovelAI 返回的图片压缩包无效");
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (
    entryCount === 0xffff ||
    centralOffset === 0xffffffff ||
    entryCount > MAX_ZIP_ENTRIES
  ) {
    throw new Error("NovelAI 返回的压缩包结构不受支持");
  }

  const images = [];
  let offset = centralOffset;
  let extractedBytes = 0;
  for (let index = 0; index < entryCount; index++) {
    if (
      offset + 46 > archive.length ||
      archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE
    ) {
      throw new Error("NovelAI 返回的图片压缩包目录损坏");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const fileNameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    offset += 46 + fileNameLength + extraLength + commentLength;

    if ((flags & 0x1) !== 0 || ![0, 8].includes(method)) continue;
    if (
      localOffset + 30 > archive.length ||
      archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE
    ) {
      throw new Error("NovelAI 返回的图片压缩包条目损坏");
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > archive.length) {
      throw new Error("NovelAI 返回的图片压缩包条目越界");
    }
    if (extractedBytes + uncompressedSize > MAX_RESPONSE_BYTES) {
      throw new Error("NovelAI 返回的图片总体积过大");
    }

    const compressed = archive.subarray(dataOffset, dataEnd);
    const image =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, {
            maxOutputLength: Math.min(
              MAX_RESPONSE_BYTES - extractedBytes,
              Math.max(uncompressedSize, 1)
            ),
          });
    if (uncompressedSize && image.length !== uncompressedSize) {
      throw new Error("NovelAI 返回的图片压缩包大小校验失败");
    }
    extractedBytes += image.length;
    if (isImageBuffer(image)) images.push(image);
  }

  if (images.length === 0) throw new Error("NovelAI 没有返回图片数据");
  return images;
}

function novelAIServiceRoot(baseURL) {
  return String(baseURL || "https://image.novelai.net")
    .replace(/\/+$/, "")
    .replace(/\/ai\/(?:generate-image|encode-vibe)$/i, "")
    .replace(/\/ai$/i, "");
}

export function novelAIGenerationEndpoint(baseURL) {
  return `${novelAIServiceRoot(baseURL)}/ai/generate-image`;
}

export function novelAISubscriptionEndpoint(baseURL) {
  return `${novelAIServiceRoot(baseURL)}/user/subscription`;
}

export function novelAIVibeEndpoint(baseURL) {
  return `${novelAIServiceRoot(baseURL)}/ai/encode-vibe`;
}

async function readResponseCapped(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("NovelAI 返回的数据体积过大");
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RESPONSE_BYTES) {
      throw new Error("NovelAI 返回的数据体积过大");
    }
    return buffer;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_RESPONSE_BYTES) {
      throw new Error("NovelAI 返回的数据体积过大");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function getNovelAIUsageCooldownKey(token) {
  const tokenHash = createHash("sha256")
    .update(String(token))
    .digest("hex")
    .slice(0, 24);
  return `sakura:nai:usage-limit:${tokenHash}`;
}

function normalizeCooldownSeconds(timeUntilNextPercent) {
  const seconds = Number(timeUntilNextPercent);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return NAI_USAGE_FALLBACK_COOLDOWN_SECONDS;
  }
  return Math.max(1, Math.ceil(seconds));
}

function formatCooldownDuration(seconds) {
  const totalSeconds = Math.max(1, Math.ceil(Number(seconds) || 1));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.ceil(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function createUsageLimitError(
  percent,
  cooldownSeconds,
  { tier = null, active = false } = {}
) {
  const percentText = Number.isFinite(Number(percent))
    ? `${Number(percent)}%`
    : "未知";
  const error = new Error(
    `NovelAI V5 用量仅剩 ${percentText}，已暂停生图；预计 ${formatCooldownDuration(
      cooldownSeconds
    )}后恢复下一档，请稍后再试`
  );
  error.code = "NAI_USAGE_LIMIT";
  error.percent = percent;
  error.cooldownSeconds = cooldownSeconds;
  error.subscriptionTier = tier;
  error.subscriptionActive = Boolean(active);
  return error;
}

export async function checkNovelAIUsageLimit(
  token,
  {
    redisClient = globalThis.redis,
    fetchImpl = globalThis.fetch,
    subscriptionURL = novelAISubscriptionEndpoint(),
  } = {}
) {
  if (!redisClient) {
    throw new Error("Redis 未连接，无法验证 NovelAI 用量，已停止生图");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("无法请求 NovelAI 用量接口，已停止生图");
  }

  const cooldownKey = getNovelAIUsageCooldownKey(token);
  let cooldown;
  try {
    cooldown = await redisClient.get(cooldownKey);
  } catch (error) {
    throw new Error(`读取 NovelAI 用量冷却失败，已停止生图：${error.message}`);
  }

  if (cooldown) {
    let ttl = NAI_USAGE_FALLBACK_COOLDOWN_SECONDS;
    try {
      const redisTtl = await redisClient.ttl(cooldownKey);
      if (redisTtl > 0) ttl = redisTtl;
    } catch {
      // The cooldown is already active; keep the conservative rejection.
    }

    let lockedUsage = {};
    try {
      lockedUsage = JSON.parse(cooldown);
    } catch {
      lockedUsage = {};
    }
    throw createUsageLimitError(lockedUsage.percent, ttl, {
      tier: lockedUsage.tier,
      active: lockedUsage.active,
    });
  }

  let response;
  try {
    response = await fetchImpl(subscriptionURL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    throw new Error(`NovelAI 用量查询失败，已停止生图：${error.message}`);
  }

  if (!response.ok) {
    throw new Error(
      `NovelAI 用量查询失败（HTTP ${response.status}），已停止生图`
    );
  }

  let subscription;
  try {
    subscription = await response.json();
  } catch {
    throw new Error("NovelAI 用量接口返回异常，已停止生图");
  }
  const usage = subscription?.usage;
  const rawPercent = Number(usage?.percent);
  if (!usage || !Number.isFinite(rawPercent)) {
    throw new Error("NovelAI 未返回有效的用量限制，已停止生图");
  }

  const percent = usage.isNegative
    ? 0
    : Math.max(0, Math.min(100, rawPercent));
  const tier = Number(subscription?.tier);
  const active = Boolean(subscription?.active);
  const cooldownSeconds = normalizeCooldownSeconds(
    usage.timeUntilNextPercent
  );
  if (percent <= NAI_USAGE_MIN_PERCENT) {
    const lockValue = JSON.stringify({
      percent,
      timeUntilNextPercent: cooldownSeconds,
      tier,
      active,
      lockedAt: Date.now(),
    });
    try {
      await redisClient.set(
        cooldownKey,
        lockValue,
        "EX",
        cooldownSeconds
      );
    } catch (error) {
      throw new Error(
        `设置 NovelAI 用量冷却失败，已停止生图：${error.message}`
      );
    }
    throw createUsageLimitError(percent, cooldownSeconds, { tier, active });
  }

  return {
    percent,
    isNegative: Boolean(usage.isNegative),
    timeUntilNextPercent: cooldownSeconds,
    tier,
    active,
  };
}

function getNovelAIErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current != null && !seen.has(current)) {
    chain.push(current);
    if (typeof current !== "object") break;
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

export function getNovelAIErrorStatus(error) {
  for (const item of getNovelAIErrorChain(error)) {
    if (typeof item !== "object" || item == null) continue;
    const status = Number(
      item.status ?? item.statusCode ?? item.response?.status
    );
    if (Number.isInteger(status) && status > 0) return status;
  }
  return null;
}

export function isRetryableNovelAIImageError(error) {
  if (getNovelAIErrorStatus(error) === 429) return true;
  return getNovelAIErrorChain(error).some((item) => {
    const code = String(item?.code || "").toUpperCase();
    if (NAI_RETRYABLE_NETWORK_CODES.has(code)) return true;
    const name = String(item?.name || "").toLowerCase();
    if (name === "aborterror" || name === "timeouterror") return true;
    const message = String(item?.message ?? item ?? "");
    return NAI_RETRYABLE_NETWORK_MESSAGE.test(message);
  });
}

function waitForNovelAIRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function performNovelAIImageRequest({
  endpoint,
  apiKey,
  payload,
  timeoutMs,
  fetchImpl,
}) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    let detail;
    try {
      detail = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
    } catch (error) {
      const responseError = new Error(error?.message || String(error), {
        cause: error,
      });
      responseError.status = response.status;
      throw responseError;
    }
    const requestError = new Error(
      `NovelAI API 请求失败：HTTP ${response.status}${
        detail ? ` ${detail}` : ""
      }`
    );
    requestError.status = response.status;
    throw requestError;
  }
  return extractNovelAIImages(await readResponseCapped(response));
}

export async function requestNovelAIImagesWithRetry({
  endpoint,
  apiKey,
  payload,
  timeoutMs = 120_000,
  fetchImpl = globalThis.fetch,
  retryDelaysMs = NAI_IMAGE_RETRY_DELAYS_MS,
  waitImpl = waitForNovelAIRetry,
  onRetry = (message) => logger.warn(message),
}) {
  for (let retryIndex = 0; ; retryIndex += 1) {
    try {
      return await performNovelAIImageRequest({
        endpoint,
        apiKey,
        payload,
        timeoutMs,
        fetchImpl,
      });
    } catch (error) {
      const retryDelayMs = retryDelaysMs[retryIndex];
      if (
        retryDelayMs == null ||
        !isRetryableNovelAIImageError(error)
      ) {
        throw error;
      }
      const retryNumber = retryIndex + 1;
      const reason =
        getNovelAIErrorStatus(error) === 429
          ? "HTTP 429"
          : error?.message || String(error);
      onRetry?.(
        `[NAI] 生图请求失败（${reason}），${
          retryDelayMs / 1000
        } 秒后进行第 ${retryNumber}/${retryDelaysMs.length} 次重试`
      );
      await waitImpl(retryDelayMs);
    }
  }
}

async function requestSingleNovelAIImage({
  channel,
  apiKey,
  prompt,
  sources = [],
  parameters = {},
  characters = [],
  negative = null,
  timeoutMs = 120_000,
  redisClient = globalThis.redis,
  fetchImpl = globalThis.fetch,
  retryDelaysMs = NAI_IMAGE_RETRY_DELAYS_MS,
  waitImpl = waitForNovelAIRetry,
  onRetry,
}) {
  const requestedModel = channel.model || DEFAULT_NOVELAI_MODEL;
  let useModel = resolveNovelAIModelForRequest(requestedModel, parameters);
  if (useModel !== requestedModel) {
    logger.warn(
      `[NAI] V5 暂不支持 Vibe Transfer，已自动切换为 ${useModel}`
    );
  }

  let payload = buildNovelAIRequest({
    channel,
    prompt,
    source: sources[0] || null,
    model: useModel,
    negative,
    parameters,
    characters,
  });
  if (
    useModel !== requestedModel &&
    !isNovelAI45ZeroAnlasGeneration(payload)
  ) {
    throw new Error(
      "Vibe Transfer 已切换到 V4.5，但当前请求包含底图或超出免费规格，已停止生图以避免消耗 Anlas"
    );
  }

  if (
    getNovelAIModelProfile(useModel).family === "v5" &&
    channel.checkV5Usage !== false
  ) {
    try {
      await checkNovelAIUsageLimit(apiKey, {
        redisClient,
        fetchImpl,
        subscriptionURL: novelAISubscriptionEndpoint(channel.baseURL),
      });
    } catch (error) {
      if (!canUseFreeNovelAI45Fallback(payload, error)) {
        if (error.code === "NAI_USAGE_LIMIT") {
          throw new Error(
            `${error.message}；当前请求不符合 V4.5 免费条件，未自动降级以避免消耗 Anlas`
          );
        }
        throw error;
      }

      const fallbackModel = getNovelAI45FallbackModel(useModel);
      try {
        payload = buildNovelAIRequest({
          channel,
          prompt,
          source: sources[0] || null,
          model: fallbackModel,
          negative,
          parameters,
          characters,
        });
      } catch (fallbackError) {
        throw new Error(
          `${error.message}；自动降级 V4.5 失败：${fallbackError.message}`
        );
      }
      useModel = fallbackModel;
      logger.warn(
        `[NAI] V5 用量为 ${error.percent}%，已自动切换为 ${useModel}`
      );
    }
  }

  return requestNovelAIImagesWithRetry({
    endpoint: novelAIGenerationEndpoint(channel.baseURL),
    apiKey,
    payload,
    timeoutMs,
    fetchImpl,
    retryDelaysMs,
    waitImpl,
    onRetry,
  });
}

/**
 * Split a configured image count into serialized single-image API requests.
 * The callback is only notified; its return value is deliberately not awaited,
 * so delivery can overlap with the next generation request.
 */
export async function requestNovelAIImages(request = {}) {
  const {
    options = {},
    onImageGenerated = null,
    ...singleRequest
  } = request;
  const count = clampInteger(options.count, 1, 1, 4);
  const images = [];

  for (let index = 0; index < count; index++) {
    const generated = await requestSingleNovelAIImage(singleRequest);
    for (const image of generated) {
      images.push(image);
      if (typeof onImageGenerated === "function") {
        try {
          const delivery = onImageGenerated(image, images.length - 1);
          if (delivery && typeof delivery.then === "function") {
            void Promise.resolve(delivery).catch((error) =>
              logger.warn(
                `[NAI] 单张图片生成回调失败: ${error?.message || error}`
              )
            );
          }
        } catch (error) {
          logger.warn(
            `[NAI] 单张图片生成回调失败: ${error?.message || error}`
          );
        }
      }
    }
  }

  return images;
}

const queue = [];
let isProcessing = false;

async function processNovelAIQueue() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    while (queue.length > 0) {
      const task = queue.shift();
      try {
        if (typeof task.options.onStart === "function") {
          try {
            await task.options.onStart(queue.length);
          } catch (error) {
            logger.warn(`[NAI] 队列开始通知失败: ${error.message}`);
          }
        }
        task.resolve(await requestNovelAIImages(task.options));
      } catch (error) {
        task.reject(error);
      }
    }
  } finally {
    isProcessing = false;
    if (queue.length > 0) void processNovelAIQueue();
  }
}

export function getNovelAIQueueLength() {
  return queue.length;
}

export function getNovelAIIsProcessing() {
  return isProcessing;
}

/** Serialize NovelAI requests so chat replies and explicit commands share one queue. */
export function generateNovelAIImages(options) {
  return new Promise((resolve, reject) => {
    queue.push({ options, resolve, reject });
    void processNovelAIQueue();
  });
}

export async function encodeNovelAIVibe({
  channel,
  apiKey,
  imageBase64,
  timeoutMs = 120_000,
  fetchImpl = globalThis.fetch,
}) {
  const configuredModel = channel.model || DEFAULT_NOVELAI_MODEL;
  const useModel = getNovelAIModelProfile(configuredModel).supportsVibe
    ? configuredModel
    : getNovelAI45FallbackModel(configuredModel);
  if (useModel !== configuredModel) {
    logger.warn(
      `[NAI] V5 暂不支持 Vibe Transfer 编码，已自动切换为 ${useModel}`
    );
  }

  const response = await fetchImpl(novelAIVibeEndpoint(channel.baseURL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ image: imageBase64, model: useModel }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
    throw new Error(
      `Vibe encode failed with status ${response.status}${
        detail ? `: ${detail}` : ""
      }`
    );
  }
  return (await readResponseCapped(response)).toString("base64");
}
