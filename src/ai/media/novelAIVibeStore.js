import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../logger.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const NOVELAI_VIBE_DIR = path.resolve(
  MODULE_DIR,
  "../../../data/nai/vibes"
);

function ensureDir() {
  fs.mkdirSync(NOVELAI_VIBE_DIR, { recursive: true });
}

export function normalizeNovelAIVibeName(value) {
  const name = String(value || "").trim();
  if (
    !name ||
    name.length > 80 ||
    name === "." ||
    name === ".." ||
    name.includes("..") ||
    /[\\/:*?"<>|\x00-\x1f]/.test(name)
  ) {
    throw new Error("画风名称不合法");
  }
  return name;
}

function getVibePath(name) {
  const normalized = normalizeNovelAIVibeName(name);
  const filePath = path.resolve(NOVELAI_VIBE_DIR, normalized + ".json");
  if (path.dirname(filePath) !== NOVELAI_VIBE_DIR) {
    throw new Error("画风名称不合法");
  }
  return filePath;
}

export function saveNovelAIVibe(
  name,
  encodedVibe,
  { strength = 0.6, informationExtracted = 0.7 } = {}
) {
  const normalized = normalizeNovelAIVibeName(name);
  const image = String(encodedVibe || "").trim();
  if (!image) throw new Error("NovelAI 没有返回画风编码");
  ensureDir();
  const data = {
    name: normalized,
    image,
    strength,
    informationExtracted,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(getVibePath(normalized), JSON.stringify(data), "utf8");
  return data;
}

export function getNovelAIVibe(name) {
  const filePath = getVibePath(name);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function deleteNovelAIVibe(name) {
  const filePath = getVibePath(name);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function listNovelAIVibes() {
  ensureDir();
  const vibes = [];
  for (const fileName of fs
    .readdirSync(NOVELAI_VIBE_DIR)
    .filter((item) => item.endsWith(".json"))) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(NOVELAI_VIBE_DIR, fileName), "utf8")
      );
      if (!data?.name) continue;
      vibes.push({
        name: data.name,
        strength: data.strength,
        informationExtracted: data.informationExtracted,
        createdAt: data.createdAt,
      });
    } catch (error) {
      logger.warn(
        "[NAI] 跳过损坏的画风文件 " + fileName + ": " + error.message
      );
    }
  }
  return vibes.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}
