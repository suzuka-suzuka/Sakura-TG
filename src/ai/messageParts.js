/**
 * 内部统一使用 Gemini 风格的 {text}/{inlineData} Part。
 * 到 OpenAI 请求边界时再转换。
 */
export function processQueryParts(queryParts, channelType) {
  if (!Array.isArray(queryParts) || queryParts.length === 0) {
    return queryParts;
  }

  return queryParts.map((part) => {
    if (part?.text != null) return part;
    if (part?.inlineData) {
      if (channelType === "gemini") return part;
      const { mimeType, data } = part.inlineData;
      return {
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${data}` },
      };
    }
    return part;
  });
}

export function buildOpenAIUserContent(parts = []) {
  const visibleParts = (Array.isArray(parts) ? parts : []).filter(
    (part) => part && part.thought !== true
  );
  const processedParts = processQueryParts(visibleParts, "openai") || [];

  return processedParts
    .map((part) => {
      if (part.text != null && !part.type) {
        return { type: "text", text: String(part.text) };
      }
      if (part.image_url && !part.type) {
        return { type: "image_url", image_url: part.image_url };
      }
      return part;
    })
    .filter(
      (part) => part?.type === "text" || part?.type === "image_url"
    );
}

export function buildMultimodalQueryParts(text, images = []) {
  const parts = [];
  if (String(text || "").trim()) {
    parts.push({ text: String(text) });
  }
  for (const image of Array.isArray(images) ? images : []) {
    if (!image?.base64 || !image?.mimeType) continue;
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: image.base64,
      },
    });
  }
  return parts;
}
