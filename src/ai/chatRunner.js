import { getAI } from "./getAI.js";
import { sanitizeConversationHistory } from "./conversationHistory.js";
import {
  checkAndClearStopFlag,
  finishAiTask,
  getAiTaskSignal,
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
 *
 * `onText` switches the request to streaming and receives the accumulated
 * reply text; a stop request aborts the stream immediately.
 */
export async function runChat({
  ctx,
  route,
  queryParts,
  prompt,
  history = [],
  onText = null,
  requestModel = getAI,
}) {
  const cleanHistory = sanitizeConversationHistory(history);
  const taskId = startAiTask(ctx);

  try {
    const response = await requestModel(
      route,
      ctx,
      queryParts,
      prompt,
      cleanHistory,
      { onText, signal: getAiTaskSignal(taskId) }
    );
    if (checkAndClearStopFlag(taskId)) {
      return {
        status: "stopped",
        history: cleanHistory,
        finalText: "",
      };
    }
    if (typeof response === "string") {
      return {
        status: "model_error",
        error: response,
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
