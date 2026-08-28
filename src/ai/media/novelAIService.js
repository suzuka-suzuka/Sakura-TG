import Config from "../../config.js";
import { resolveConfigValue } from "../configValue.js";
import { tagMediaError } from "./mediaErrors.js";
import {
  encodeNovelAIVibe,
  generateNovelAIImages,
} from "./novelAIProvider.js";

let keyCursor = 0;

function configuredApiValues(config) {
  if (Array.isArray(config?.api)) return config.api;
  return String(config?.api || "")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function pickApiKey(config) {
  const values = configuredApiValues(config);
  if (values.length === 0) return "";
  const value = values[keyCursor % values.length];
  keyCursor = (keyCursor + 1) % values.length;
  return String(resolveConfigValue(value) || "").trim();
}

function validateNovelAIConfig(config, apiKey) {
  if (!config?.model) throw new Error("NovelAI 未配置模型");
  if (!config?.baseURL) throw new Error("NovelAI 未配置 API 地址");
  if (!apiKey) throw new Error("NovelAI 需要 Token");
}

function normalizeSource(input) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) return { buffer: input };
  if (input.buffer) return { ...input, buffer: Buffer.from(input.buffer) };
  const base64 = input.base64 || input.inlineData?.data;
  if (!base64) return null;
  return {
    buffer: Buffer.from(String(base64).split(",").at(-1), "base64"),
    mimeType: input.mimeType || input.inlineData?.mimeType || "image/png",
    fileName: input.fileName || "reference-image",
  };
}

export async function generateNovelAIImagesWithService({
  prompt,
  images = [],
  count = 1,
  parameters = {},
  characters = [],
  negative = null,
  onQueueStart = null,
}) {
  try {
    const config = Config.get("ai.novelAI") || {};
    const apiKey = pickApiKey(config);
    validateNovelAIConfig(config, apiKey);
    const source = normalizeSource(images[0]);
    return await generateNovelAIImages({
      channel: config,
      apiKey,
      prompt,
      sources: source ? [source] : [],
      options: { count },
      parameters,
      characters,
      negative,
      onStart: onQueueStart,
      timeoutMs: Config.get("ai.requestTimeoutMs") || 120_000,
    });
  } catch (error) {
    throw tagMediaError(error, "novelai", "image");
  }
}

export async function encodeNovelAIVibeWithService({
  imageBase64,
}) {
  try {
    const config = Config.get("ai.novelAI") || {};
    const apiKey = pickApiKey(config);
    validateNovelAIConfig(config, apiKey);
    return await encodeNovelAIVibe({
      channel: config,
      apiKey,
      imageBase64,
      timeoutMs: Config.get("ai.requestTimeoutMs") || 120_000,
    });
  } catch (error) {
    throw tagMediaError(error, "novelai", "image");
  }
}
