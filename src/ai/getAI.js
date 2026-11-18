import { ThinkingLevel } from "@google/genai";
import OpenAI from "openai";
import Config from "../config.js";
import { logger } from "../logger.js";
import {
  buildOpenAIUserContent,
  processQueryParts,
} from "./messageParts.js";
import {
  createRouteExecutionPlan,
  formatRouteAttemptFailure,
  isRequestConfigComplete,
} from "./providerRouter.js";
import { createGeminiClient } from "./vertexAuth.js";

const OPENAI_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const GEMINI_THINKING_LEVELS = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export const AI_REQUEST_STOPPED_MESSAGE = "AI 请求已停止";

function normalizeRequestError(error) {
  if (error?.isAIRequestError) return error;
  const wrapped = new Error(error?.message || String(error));
  wrapped.status = Number(error?.status || error?.response?.status) || null;
  wrapped.isAIRequestError = true;
  return wrapped;
}

function requestTimeoutMs() {
  return Config.get("ai.requestTimeoutMs") || 120_000;
}

/** Combine the whole-request timeout with the user's stop signal. */
function requestSignal(timeoutMs, stopSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return stopSignal ? AbortSignal.any([timeout, stopSignal]) : timeout;
}

/** Report accumulated text without letting a display error break the stream. */
function createTextNotifier(onText) {
  if (typeof onText !== "function") return null;
  return (text) => {
    try {
      onText(text);
    } catch (error) {
      logger.warn(`[AI] 流式输出回调失败: ${error?.message || error}`);
    }
  };
}

function normalizeReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return OPENAI_REASONING_EFFORTS.has(normalized) ? normalized : "";
}

function parseCompletion(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value && typeof value.data === "string") {
    try {
      return JSON.parse(value.data);
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeOpenAIContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : part?.type === "text"
          ? part.text || ""
          : ""
    )
    .join("");
}

function textParts(parts = []) {
  return (Array.isArray(parts) ? parts : [])
    .filter((part) => typeof part?.text === "string" && part.thought !== true)
    .map((part) => ({ text: part.text }));
}

function historyToOpenAIMessages(history = []) {
  return (Array.isArray(history) ? history : []).flatMap((item) => {
    if (!item || !["user", "model"].includes(item.role)) return [];
    const text = textParts(item.parts)
      .map((part) => part.text)
      .join("");
    if (!text) return [];
    return [
      {
        role: item.role === "model" ? "assistant" : "user",
        content: text,
      },
    ];
  });
}

function historyToGeminiContents(history = []) {
  return (Array.isArray(history) ? history : []).flatMap((item) => {
    if (!item || !["user", "model"].includes(item.role)) return [];
    const parts = textParts(item.parts);
    return parts.length > 0 ? [{ role: item.role, parts }] : [];
  });
}

/**
 * The OpenAI SDK ends a stream quietly when its signal aborts, so a stop or a
 * timeout must be detected from the signal instead of a thrown error.
 */
function assertStreamNotAborted(streamSignal, stopSignal, timeoutMs) {
  if (!streamSignal.aborted) return;
  stopSignal?.throwIfAborted();
  throw new Error(`模型流式请求超时（${timeoutMs} ms）`);
}

async function readOpenAIStream(stream, notify, signal) {
  let text = "";
  let chunkCount = 0;
  for await (const chunk of stream) {
    if (signal.aborted) break;
    chunkCount += 1;
    const delta = normalizeOpenAIContent(chunk?.choices?.[0]?.delta?.content);
    if (!delta) continue;
    text += delta;
    notify(text);
  }
  return { text, chunkCount };
}

async function getOpenAIResponse(
  channel,
  queryParts,
  presetPrompt,
  history = [],
  { onText = null, signal = null } = {}
) {
  if (!isRequestConfigComplete(channel, "openai")) {
    throw new Error("OpenAI 渠道配置不完整");
  }

  const timeoutMs = requestTimeoutMs();
  const openai = new OpenAI({
    apiKey: channel.apiKey,
    ...(channel.baseURL?.trim() && { baseURL: channel.baseURL.trim() }),
    maxRetries: 0,
    timeout: timeoutMs,
  });
  const messages = [];
  const systemPrompt = String(presetPrompt || "").trim();
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push(...historyToOpenAIMessages(history));
  if (queryParts?.length) {
    messages.push({
      role: "user",
      content: buildOpenAIUserContent(queryParts),
    });
  }
  if (messages.length === 0 || messages.at(-1).role !== "user") {
    throw new Error("没有可提交给模型的查询");
  }

  const payload = {
    model: channel.model,
    messages,
    stream: false,
  };
  if (channel.openaiEnableThinking) payload.enable_thinking = true;
  if (Number.isFinite(channel.temperature)) {
    payload.temperature = channel.temperature;
  }
  if (Number.isFinite(channel.topP)) payload.top_p = channel.topP;
  const reasoningEffort = normalizeReasoningEffort(
    channel.openaiReasoningEffort
  );
  if (reasoningEffort) payload.reasoning_effort = reasoningEffort;

  const notify = createTextNotifier(onText);
  if (notify) {
    // The SDK timeout only covers the response headers, so bound the whole
    // stream with the same request timeout the non-streaming call uses.
    const streamSignal = requestSignal(timeoutMs, signal);
    const stream = await openai.chat.completions.create(
      { ...payload, stream: true },
      { signal: streamSignal }
    );
    const streamed = await readOpenAIStream(stream, notify, streamSignal);
    assertStreamNotAborted(streamSignal, signal, timeoutMs);
    if (streamed.text) return { text: streamed.text };
    if (streamed.chunkCount > 0) throw new Error("模型没有返回内容");
    // No SSE events at all: the endpoint ignored stream=true and answered
    // with a plain JSON body, so repeat the request without streaming.
    logger.warn(
      `[AI] ${channel.name || channel.model} 未返回流式数据，改用非流式请求`
    );
  }

  const completion = parseCompletion(
    await openai.chat.completions.create(
      payload,
      signal ? { signal } : undefined
    )
  );
  if (!Array.isArray(completion?.choices)) {
    throw new Error("OpenAI 兼容端点返回了异常格式");
  }
  const text = normalizeOpenAIContent(
    completion.choices[0]?.message?.content
  );
  if (!text) throw new Error("模型没有返回内容");
  notify?.(text);
  return { text };
}

function geminiCandidateText(candidate) {
  return (candidate?.content?.parts || [])
    .filter((part) => part?.thought !== true && part?.text)
    .map((part) => part.text)
    .join("");
}

function assertGeminiFinishReason(finishReason) {
  if (finishReason && !["STOP", "MAX_TOKENS"].includes(finishReason)) {
    throw new Error(`Gemini 生成中止：${finishReason}`);
  }
}

async function readGeminiStream(stream, notify, signal) {
  let text = "";
  let finishReason = null;
  for await (const chunk of stream) {
    if (signal.aborted) break;
    if (chunk?.promptFeedback?.blockReason) {
      throw new Error(`请求被拦截：${chunk.promptFeedback.blockReason}`);
    }
    const candidate = chunk?.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    const delta = geminiCandidateText(candidate);
    if (!delta) continue;
    text += delta;
    notify(text);
  }
  return { text, finishReason };
}

function finishGeminiStream({ text, finishReason }) {
  assertGeminiFinishReason(finishReason);
  if (!text) throw new Error("Gemini 返回内容为空");
  return { text };
}

async function getGeminiResponse(
  channel,
  queryParts,
  presetPrompt,
  history = [],
  { onText = null, signal = null } = {}
) {
  if (!isRequestConfigComplete(channel, "gemini")) {
    throw new Error("Gemini 渠道配置不完整");
  }

  const client = createGeminiClient(channel);
  const contents = historyToGeminiContents(history);
  if (queryParts?.length) {
    contents.push({
      role: "user",
      parts: processQueryParts(queryParts, "gemini"),
    });
  }
  if (contents.length === 0) throw new Error("没有可提交给模型的查询");

  const timeoutMs = requestTimeoutMs();
  const abortSignal = requestSignal(timeoutMs, signal);
  const requestConfig = {
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
    ],
    abortSignal,
  };
  if (Number.isFinite(channel.temperature)) {
    requestConfig.temperature = channel.temperature;
  }
  if (Number.isFinite(channel.topP)) requestConfig.topP = channel.topP;
  if (
    Number.isInteger(channel.geminiThinkingBudget) &&
    channel.geminiThinkingBudget >= -1
  ) {
    requestConfig.thinkingConfig = {
      thinkingBudget: channel.geminiThinkingBudget,
    };
  } else if (GEMINI_THINKING_LEVELS[channel.geminiThinkingLevel]) {
    requestConfig.thinkingConfig = {
      thinkingLevel: GEMINI_THINKING_LEVELS[channel.geminiThinkingLevel],
    };
  }
  const systemPrompt = String(presetPrompt || "").trim();
  if (systemPrompt) requestConfig.systemInstruction = systemPrompt;

  const request = {
    model: channel.model,
    contents,
    config: requestConfig,
  };
  const notify = createTextNotifier(onText);
  if (notify) {
    const streamed = await readGeminiStream(
      await client.models.generateContentStream(request),
      notify,
      abortSignal
    );
    assertStreamNotAborted(abortSignal, signal, timeoutMs);
    return finishGeminiStream(streamed);
  }

  const response = await client.models.generateContent(request);
  if (response?.promptFeedback?.blockReason) {
    throw new Error(`请求被拦截：${response.promptFeedback.blockReason}`);
  }
  const candidate = response?.candidates?.[0];
  if (!candidate?.content?.parts) {
    throw new Error("Gemini 没有返回候选内容");
  }
  assertGeminiFinishReason(candidate.finishReason);
  const text = geminiCandidateText(candidate);
  if (!text) throw new Error("Gemini 返回内容为空");
  return { text };
}

/**
 * Execute a pure chat route. Current images follow the same target order and
 * fallback path as text; there is deliberately no analyzer/tool fallback.
 *
 * With `options.onText`, the response is streamed and the callback receives
 * the accumulated text of the current attempt; a fallback attempt starts over
 * from its own first token. `options.signal` stops the request without trying
 * further targets.
 */
export async function getAI(
  routeId,
  _ctx,
  queryParts,
  presetPrompt,
  history = [],
  options = {}
) {
  const { onText = null, signal = null } = options || {};
  let plan;
  try {
    plan = createRouteExecutionPlan(routeId);
  } catch (error) {
    return `路由配置错误：${error.message}`;
  }
  if (plan.attempts.length === 0) {
    return `路由“${routeId}”没有可用的供应商目标或凭据`;
  }

  let lastError = null;
  for (let index = 0; index < plan.attempts.length; index++) {
    if (signal?.aborted) return AI_REQUEST_STOPPED_MESSAGE;
    const attempt = plan.attempts[index];
    const channel = attempt.requestConfig;
    logger.info(
      `[AI Router] route=${routeId} target=${attempt.target.id} provider=${attempt.provider.id} credential=${attempt.credential.id} model=${channel.model}`
    );
    const requestOptions = { onText, signal };
    try {
      const response =
        channel.channelType === "gemini"
          ? await getGeminiResponse(
              channel,
              queryParts,
              presetPrompt,
              history,
              requestOptions
            )
          : await getOpenAIResponse(
              channel,
              queryParts,
              presetPrompt,
              history,
              requestOptions
            );
      if (signal?.aborted) return AI_REQUEST_STOPPED_MESSAGE;
      return {
        ...response,
        sourceProtocol: channel.channelType,
        requestQueryParts: queryParts,
      };
    } catch (error) {
      if (signal?.aborted) return AI_REQUEST_STOPPED_MESSAGE;
      lastError = normalizeRequestError(error);
    }

    const nextAttempt = plan.attempts[index + 1] || null;
    logger.warn(
      formatRouteAttemptFailure({
        routeId,
        attempt,
        error: lastError,
        attemptNumber: index + 1,
        totalAttempts: plan.attempts.length,
        nextAttempt,
        retryDelayMs: plan.route.retryDelayMs,
      })
    );
    if (nextAttempt && plan.route.retryDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, plan.route.retryDelayMs)
      );
    }
  }

  logger.error(
    `[AI Router] 路由 ${routeId} 请求全部失败: ${
      lastError?.message || "未知错误"
    }`
  );
  return `路由“${routeId}”请求失败，请查看机器人日志`;
}
