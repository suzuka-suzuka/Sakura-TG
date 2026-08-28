const POSITION_ALIASES = [
  ["左上", { x: 0.3, y: 0.3 }],
  ["右上", { x: 0.7, y: 0.3 }],
  ["左下", { x: 0.3, y: 0.7 }],
  ["右下", { x: 0.7, y: 0.7 }],
  ["中间", { x: 0.5, y: 0.5 }],
  ["中心", { x: 0.5, y: 0.5 }],
  ["左", { x: 0.3, y: 0.5 }],
  ["右", { x: 0.7, y: 0.5 }],
  ["上", { x: 0.5, y: 0.3 }],
  ["下", { x: 0.5, y: 0.7 }],
  ["中", { x: 0.5, y: 0.5 }],
];

const PERCENT_COORDINATE_RE =
  /^@\s*(100(?:\.0+)?|[0-9]{1,2}(?:\.\d+)?)\s*[%％]?\s*[,，]\s*(100(?:\.0+)?|[0-9]{1,2}(?:\.\d+)?)\s*[%％]?\s*[:：]\s*([\s\S]*)$/;

export function parseNovelAICharacterPrompt(content) {
  let text = String(content || "").trim();
  let center = { x: 0.5, y: 0.5 };

  const coordinateMatch = text.match(PERCENT_COORDINATE_RE);
  if (coordinateMatch) {
    center = {
      x: Number(coordinateMatch[1]) / 100,
      y: Number(coordinateMatch[2]) / 100,
    };
    text = coordinateMatch[3].trim();
  } else {
    for (const [name, position] of POSITION_ALIASES) {
      if (!text.startsWith(name)) continue;
      center = position;
      text = text
        .slice(name.length)
        .replace(/^[,，:：\s]+/, "")
        .trim();
      break;
    }
  }

  if (!text) return null;
  return {
    prompt: text,
    uc: "",
    center,
    enabled: true,
  };
}

/**
 * Split a NovelAI prompt into the global scene prompt and independent
 * character prompts. This syntax is shared by explicit /nai commands and the
 * hidden RP <draw> protocol.
 */
export function parseNovelAIPromptWithCharacters(rawText) {
  const characters = [];
  const prompt = String(rawText || "")
    .replace(/\[([\s\S]*?)\]/g, (_match, content) => {
      const character = parseNovelAICharacterPrompt(content);
      if (character) characters.push(character);
      return "";
    })
    .trim();
  return { prompt, characters };
}

/**
 * Parse the original Sakura 绘图 command syntax:
 *   绘图 [画风名] 横|方|竖 [左: character] prompt
 * Coordinates also accept [@12.5,80: character].
 */
export function parseNovelAICommandArgs(
  rawText,
  { vibes = [], resolveVibe = null } = {}
) {
  let text = String(rawText || "").trim();
  let vibeData = null;
  const sortedVibes = [...vibes]
    .filter((item) => item?.name)
    .sort((a, b) => b.name.length - a.name.length);
  for (const vibe of sortedVibes) {
    if (!text.startsWith(vibe.name)) continue;
    vibeData =
      typeof resolveVibe === "function"
        ? resolveVibe(vibe.name)
        : vibe;
    text = text.slice(vibe.name.length).trim();
    break;
  }

  const parsedPrompt = parseNovelAIPromptWithCharacters(text);
  const characters = parsedPrompt.characters;
  let prompt = parsedPrompt.prompt;

  let width = 832;
  let height = 1216;
  let aspect = "竖";
  if (prompt.includes("横")) {
    width = 1216;
    height = 832;
    aspect = "横";
    prompt = prompt.replace(/横/g, "");
  } else if (prompt.includes("方")) {
    width = 1024;
    height = 1024;
    aspect = "方";
    prompt = prompt.replace(/方/g, "");
  } else if (prompt.includes("竖")) {
    prompt = prompt.replace(/竖/g, "");
  }

  prompt = prompt
    .replace(/\s+/g, " ")
    .replace(/^,+|,+$/g, "")
    .trim();
  return {
    vibeData,
    characters,
    prompt,
    width,
    height,
    aspect,
    isValid: Boolean(prompt || characters.length > 0 || vibeData),
  };
}
