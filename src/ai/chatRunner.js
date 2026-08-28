import { getAI } from "./getAI.js";
import { sanitizeConversationHistory } from "./conversationHistory.js";
import {
  checkAndClearStopFlag,
  finishAiTask,
  startAiTask,
} from "./stopFlag.js";

function persistentUserParts(queryParts = []) {
  return (Array.isArray(queryParts) ? queryParts : [])
    .filter((part) => typeof part?.text === "string")
    .map((part) => ({ text: part.text }));
}

/**
 * One roleplay turn: send the current text/images directly to the configured
 * chat route and persist only visible text. There are no tools, intermediate
 * tool messages, group context, image-analysis fallbacks, or long-term memory.
 */
export async function runChat({
  ctx,
  route,
  queryParts,
  prompt,
  history = [],
}) {
  const cleanHistory = sanitizeConversationHistory(history);
  const taskId = startAiTask(ctx);

  try {
    const response = await getAI(
      route,
      ctx,
      queryParts,
      prompt,
      cleanHistory
    );
    if (typeof response === "string") {
      return {
        status: "model_error",
        error: response,
        history: cleanHistory,
        finalText: "",
      };
    }
    if (checkAndClearStopFlag(taskId)) {
      return {
        status: "stopped",
        history: cleanHistory,
        finalText: "",
      };
    }

    const finalText = String(response?.text || "");
    if (!finalText) {
      return {
        status: "empty",
        history: cleanHistory,
        finalText: "",
      };
    }

    const userParts = persistentUserParts(queryParts);
    if (userParts.length > 0) {
      cleanHistory.push({ role: "user", parts: userParts });
    }
    cleanHistory.push({ role: "model", parts: [{ text: finalText }] });
    return {
      status: "completed",
      history: cleanHistory,
      finalText,
    };
  } finally {
    finishAiTask(ctx, taskId);
  }
}
