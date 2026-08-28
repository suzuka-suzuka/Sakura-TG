import { parseNovelAIPromptWithCharacters } from "./media/novelAICommand.js";

const CHARACTER_TAG_RULE_MARKER =
  "When a recognized English Danbooru/NovelAI character tag is present";

export const CHAT_DRAW_CHARACTER_TAG_RULE = `- ${CHARACTER_TAG_RULE_MARKER}, treat it as the source of the character's canonical identity. Do not repeat inherent appearance traits already encoded by that tag, including canonical hair color or style, eye color, body traits, default outfit, or default accessories. Add only scene-specific changes and current-state details such as changed clothing or accessories, pose, action, expression, gaze, interaction, and character-specific objects.
- Only when no reliable recognized character tag exists, describe enough stable visible traits to identify an original or unknown character. Include 1girl, 1boy, or another accurate count, and never invent a character tag.`;

export const DEFAULT_CHAT_DRAW_PROMPT = `**[RP Visual Snapshot — hidden backend tag, no image-tool call]**
Continue the roleplay response normally. Do not call an image-generation tool for this snapshot. At the absolute end of the response, append exactly one compact <draw>...</draw> block for the backend to remove from the visible reply and render asynchronously. The closing </draw> tag must be the final characters of the response. Never mention this hidden tag in the roleplay text.

The tag must describe exactly one concrete visible frame from the current moment. Include only visually observable information and preserve roleplay continuity.

Every visual description must use one of two forms:
1. Accurate English NovelAI/Danbooru-style tags separated by commas.
2. When tags cannot clearly express an interaction or spatial relationship, one concise but grammatically complete English sentence with an explicit subject and verb.
Never use natural-language fragments, shorthand phrases, or incomplete clauses. For example, use tags such as "leaning forward, looking at another", or write the complete sentence "A silver-haired girl leans across the table while the black-haired girl watches her." Do not write fragments such as "silver-haired girl leaning across the table".

For one visible character, a flat prompt remains valid:
<draw>1girl, original character, long silver hair, blue eyes, oversized white shirt, sitting, bed, gentle smile, looking at viewer, bedroom, night, bedside lamp, cowboy shot, eye-level, warm backlighting</draw>

When a reliable character tag exists, use it without reconstructing the character's canonical features. For example, do not add teal hair, twintails, or teal eyes after the recognized tag:
<draw>1girl, hatsune miku (vocaloid), oversized hoodie, sitting, bed, gentle smile, looking at viewer, bedroom, night, bedside lamp, cowboy shot, eye-level, warm backlighting</draw>

For multiple visible characters, write the shared scene outside square brackets and one independent character prompt in each bracket:
<draw>2girls, bedroom, night, bed, sitting, talking, medium shot, eye-level, warm lighting [左: 1girl, long black hair, green eyes, white pajamas, gentle smile, holding pillow, looking at another] [右: 1girl, long silver hair, blue eyes, oversized black shirt, blush, leaning forward, looking at another]</draw>

Character positions accept 左, 右, 左上, 右上, 左下, 右下, 中间, 上, and 下. Exact percentage coordinates use [@25,55: character tags].

Multi-character rules:
- Outside the brackets, write only the total visible character count, environment, interaction, important props, framing, camera angle, lighting, color mood, and visual effects.
- Inside each character bracket, write the recognized character tag or, only when no reliable tag exists, the stable visible appearance. Then add only scene-specific clothing or accessories, pose, action, expression, gaze, interaction, and character-specific objects.
- Do not repeat different characters' hair, eye, or clothing traits in the shared prompt; this reduces attribute bleeding.

General rules:
${CHAT_DRAW_CHARACTER_TAG_RULE}
- Describe the current scene, not a generic character sheet. Do not invent extra people, clothing changes, camera text, watermarks, dialogue boxes, or a new art style.
- Do not include thoughts, personality, backstory, sounds, smells, or spoken dialogue. Spoken dialogue is not visible image text unless the user explicitly asks for text in the picture.
- Keep the global prompt and every character block concise. Keep the entire <draw> block on one line, do not use Markdown fences, and do not output more than one block.`;

export function ensureChatDrawCharacterTagRule(value) {
  if (value === undefined || value === null) return value;
  const prompt = String(value);
  if (!prompt.trim() || prompt.includes(CHARACTER_TAG_RULE_MARKER)) {
    return prompt;
  }
  return `${prompt.trimEnd()}\n\nCharacter-tag appearance rules:\n${CHAT_DRAW_CHARACTER_TAG_RULE}`;
}

function normalizeDrawPrompt(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, ", ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/^\s*,|,\s*$/g, "")
    .trim();
}

export function appendDrawPrompt(basePrompt, suffix) {
  return [normalizeDrawPrompt(basePrompt), normalizeDrawPrompt(suffix)]
    .filter(Boolean)
    .join(", ");
}

/**
 * Collect prompts from <draw> tags and return a tag-free text copy for callers
 * that need one. A truncated trailing tag remains usable for generation.
 */
export function parseChatDrawTags(message) {
  const prompts = [];
  const rawPrompts = [];
  const collect = (content) => {
    const rawPrompt = String(content || "").trim();
    const prompt = normalizeDrawPrompt(content);
    if (prompt) {
      prompts.push(prompt);
      rawPrompts.push(rawPrompt);
    }
    return "";
  };

  let text = String(message || "");
  text = text.replace(
    /<draw(?:\s[^>]*)?>([\s\S]*?)<\/draw\s*>/gi,
    (_match, content) => collect(content)
  );
  text = text.replace(
    /<draw(?:\s[^>]*)?>([\s\S]*)$/i,
    (_match, content) => collect(content)
  );
  text = text
    .replace(/<\/?draw(?:\s[^>]*)?>/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, prompts, rawPrompts };
}

/** Remove backend-only draw metadata before model replies enter Redis history. */
export function stripChatDrawTagsFromHistory(history = []) {
  if (!Array.isArray(history)) return [];
  return history.flatMap((item) => {
    if (item?.role !== "model" || !Array.isArray(item.parts)) return [item];
    const parts = item.parts.flatMap((part) => {
      if (typeof part?.text !== "string") return [part];
      const text = parseChatDrawTags(part.text).text;
      return text ? [{ ...part, text }] : [];
    });
    return parts.length > 0 ? [{ ...item, parts }] : [];
  });
}

/**
 * Start drawing before the tag-free Telegram reply is awaited. The returned
 * drawTask intentionally remains in the background; callers may attach
 * logging without making text delivery wait for image generation.
 */
export async function dispatchTaggedChatResponse({
  responseText,
  drawingEnabled = false,
  promptSuffix = "",
  drawState = null,
  sendText,
  startDrawing,
}) {
  const parsed = parseChatDrawTags(responseText);
  const extractedPrompt = parsed.prompts[0];
  const parsedDraw = extractedPrompt
    ? parseNovelAIPromptWithCharacters(extractedPrompt)
    : { prompt: "", characters: [] };
  const hasTaggedDraw = Boolean(
    extractedPrompt && (parsedDraw.prompt || parsedDraw.characters.length > 0)
  );
  const drawPrompt = hasTaggedDraw
    ? appendDrawPrompt(parsedDraw.prompt, promptSuffix)
    : "";
  const drawRequest = hasTaggedDraw
    ? { prompt: drawPrompt, characters: parsedDraw.characters }
    : null;
  const shouldDraw =
    drawingEnabled &&
    drawRequest &&
    drawState?.scheduled !== true &&
    typeof startDrawing === "function";
  if (shouldDraw && drawState) drawState.scheduled = true;
  const drawTask = shouldDraw
    ? Promise.resolve().then(() => startDrawing(drawRequest))
    : null;

  // Attach a handler immediately so a very fast drawing failure cannot become
  // an unhandled rejection while Telegram is still sending the text.
  if (drawTask) void drawTask.catch(() => {});

  const visibleText = parsed.text;
  if (visibleText && typeof sendText === "function") {
    await Promise.resolve().then(() => sendText(visibleText));
  }

  return {
    ...parsed,
    visibleText,
    rawDrawPrompt: parsed.rawPrompts[0] || "",
    drawPrompt,
    characters: parsedDraw.characters,
    drawRequest,
    drawTask,
  };
}
