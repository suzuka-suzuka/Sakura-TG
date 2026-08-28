import { resolveConfigValue } from "./configValue.js";
import { createGeminiClient } from "./vertexAuth.js";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL_LIMIT = 500;
const MAX_GEMINI_PAGES = 100;

function discoveryError(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function abortError() {
  const error = new Error("模型列表请求已取消");
  error.name = "AbortError";
  return error;
}

function safeProviderId(provider) {
  return String(provider?.id || "").trim().slice(0, 128);
}

function resolvedCredentialSecret(credential) {
  return String(resolveConfigValue(credential?.apiKey) || "").trim();
}

function providerSecrets(provider) {
  return (Array.isArray(provider?.credentials) ? provider.credentials : [])
    .map(resolvedCredentialSecret)
    .filter(Boolean);
}

export function redactProviderModelError(error, provider) {
  let message = error?.message || String(error || "未知错误");
  for (const secret of providerSecrets(provider)) {
    message = message.split(secret).join("[REDACTED]");
  }
  return message
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(x-goog-api-key\s*:\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:key|api_key|access_token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function normalizeModelId(value) {
  const raw = typeof value === "string" ? value : value?.id || value?.name;
  if (typeof raw !== "string" || !raw.trim()) return "";

  const normalized = raw.trim();
  const vertexMarker = normalized.lastIndexOf("/models/");
  if (vertexMarker >= 0) {
    return normalized.slice(vertexMarker + "/models/".length).trim();
  }
  return normalized.replace(/^models\//, "").trim();
}

export function normalizeProviderModels(models, limit = DEFAULT_MODEL_LIMIT) {
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_MODEL_LIMIT, DEFAULT_MODEL_LIMIT));
  const seen = new Set();
  const values = [];

  for (const model of Array.isArray(models) ? models : []) {
    const id = normalizeModelId(model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    values.push(id);
    if (values.length >= normalizedLimit) break;
  }

  return values.sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
  );
}

function createRequestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal?.reason);

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function normalizeBaseUrl(value, fallback, label) {
  let url;
  try {
    url = new URL(String(value || fallback).trim());
  } catch {
    throw discoveryError(`${label}不是有效的 HTTP 地址`, 400);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw discoveryError(`${label}只支持 HTTP 或 HTTPS`, 400);
  }
  if (url.username || url.password) {
    throw discoveryError(`${label}不能包含用户名或密码`, 400);
  }
  url.hash = "";
  return url;
}

function openAIModelsUrl(provider) {
  const url = normalizeBaseUrl(
    provider.baseURL,
    DEFAULT_OPENAI_BASE_URL,
    "OpenAI API 地址"
  );
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.toLowerCase().endsWith("/models")) {
    url.pathname = `${pathname}/models`;
  }
  return url;
}

function geminiModelsUrl(provider) {
  const url = normalizeBaseUrl(
    provider.baseURL,
    DEFAULT_GEMINI_BASE_URL,
    "Gemini API 地址"
  );
  let pathname = url.pathname.replace(/\/+$/, "");
  const lowerPath = pathname.toLowerCase();

  if (lowerPath.endsWith("/models")) return url;
  if (lowerPath.endsWith("/v1") || lowerPath.endsWith("/v1beta")) {
    pathname = pathname.replace(/\/v1(?:beta)?$/i, "/v1beta");
    url.pathname = `${pathname}/models`;
    return url;
  }

  url.pathname = `${pathname}/v1beta/models`;
  return url;
}

async function fetchJson(url, init, options) {
  const requestSignal = createRequestSignal(options.signal, options.timeoutMs);
  try {
    const response = await options.fetchImpl(url, {
      ...init,
      signal: requestSignal.signal,
    });
    if (!response?.ok) {
      const status = Number(response?.status) || 0;
      throw new Error(
        status > 0
          ? `模型列表端点返回 HTTP ${status}`
          : "模型列表端点没有返回有效响应"
      );
    }
    try {
      return await response.json();
    } catch {
      throw new Error("模型列表端点返回的不是有效 JSON");
    }
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    if (requestSignal.timedOut()) {
      throw new Error(`模型列表请求超时（${options.timeoutMs} 毫秒）`);
    }
    throw error;
  } finally {
    requestSignal.cleanup();
  }
}

async function fetchOpenAIModels(provider, credential, options) {
  const payload = await fetchJson(
    openAIModelsUrl(provider),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential.apiKey}`,
      },
    },
    options
  );

  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  throw new Error("OpenAI 模型端点返回格式异常");
}

function supportsGenerateContent(model) {
  const actions = model?.supportedActions || model?.supportedGenerationMethods;
  return (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    actions.includes("generateContent")
  );
}

async function fetchGeminiApiModels(provider, credential, options) {
  const baseUrl = geminiModelsUrl(provider);
  const models = [];
  const seenPageTokens = new Set();
  let pageToken = "";

  for (let page = 0; page < MAX_GEMINI_PAGES; page += 1) {
    const url = new URL(baseUrl);
    url.searchParams.set(
      "pageSize",
      String(Math.min(100, Math.max(1, options.limit - models.length)))
    );
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const payload = await fetchJson(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "x-goog-api-key": credential.apiKey,
        },
      },
      options
    );
    if (!Array.isArray(payload?.models)) {
      throw new Error("Gemini 模型端点返回格式异常");
    }
    models.push(...payload.models.filter(supportsGenerateContent));
    if (models.length >= options.limit) break;

    const nextPageToken = String(payload.nextPageToken || "").trim();
    if (!nextPageToken || seenPageTokens.has(nextPageToken)) break;
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  return models;
}

async function fetchVertexModels(provider, credential, options) {
  const requestSignal = createRequestSignal(options.signal, options.timeoutMs);
  try {
    const client = options.geminiClientFactory({
      ...provider,
      apiKey: credential.apiKey,
      serviceAccountRef: credential.serviceAccountRef,
    });
    const pager = await client.models.list({
      config: {
        pageSize: Math.min(100, options.limit),
        abortSignal: requestSignal.signal,
      },
    });
    const models = [];

    if (pager?.[Symbol.asyncIterator]) {
      for await (const model of pager) {
        if (supportsGenerateContent(model)) models.push(model);
        if (models.length >= options.limit) break;
      }
    } else {
      const page = Array.isArray(pager?.page)
        ? pager.page
        : Array.isArray(pager?.models)
          ? pager.models
          : [];
      models.push(...page.filter(supportsGenerateContent).slice(0, options.limit));
    }
    return models;
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    if (requestSignal.timedOut()) {
      throw new Error(`模型列表请求超时（${options.timeoutMs} 毫秒）`);
    }
    throw error;
  } finally {
    requestSignal.cleanup();
  }
}

function orderedCredentials(provider) {
  return (Array.isArray(provider.credentials) ? provider.credentials : [])
    .map((credential, index) => ({
      ...credential,
      apiKey: resolvedCredentialSecret(credential),
      serviceAccountRef: String(credential?.serviceAccountRef || "").trim(),
      _index: index,
    }))
    .filter((credential) => credential.enabled !== false)
    .sort((left, right) => {
      const priorityDifference =
        (Number(right.priority) || 0) - (Number(left.priority) || 0);
      return priorityDifference || left._index - right._index;
    });
}

function validateProvider(provider) {
  const id = safeProviderId(provider);
  if (!id) throw discoveryError("供应商 ID 不能为空", 400);
  const protocol = String(provider?.protocol || "").trim().toLowerCase();
  if (!["openai", "gemini"].includes(protocol)) {
    throw discoveryError(`不支持的供应商协议：${protocol || "未填写"}`, 400);
  }
  if (provider?.vertex === true && protocol !== "gemini") {
    throw discoveryError("Vertex 只能用于 Gemini 协议", 400);
  }
  return {
    ...provider,
    id,
    protocol,
    baseURL: String(provider?.baseURL || "").trim(),
    vertex: provider?.vertex === true,
  };
}

/**
 * 从供应商的远程模型端点读取可选模型。调用方可注入 fetch/client，
 * 以便测试时完全不访问真实模型服务。
 */
export async function listProviderModels(provider, options = {}) {
  const normalizedProvider = validateProvider(provider);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw discoveryError("当前运行环境不支持读取远程模型列表", 500);
  }

  const limit = Math.max(
    1,
    Math.min(Number(options.limit) || DEFAULT_MODEL_LIMIT, DEFAULT_MODEL_LIMIT)
  );
  const timeoutMs = Math.max(
    100,
    Math.min(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 120_000)
  );
  const credentials = orderedCredentials(normalizedProvider);
  if (credentials.length === 0) {
    throw discoveryError(`供应商 ${normalizedProvider.id} 没有启用的凭据`, 400);
  }

  const usableCredentials = credentials.filter((credential) =>
    normalizedProvider.vertex ? credential.serviceAccountRef : credential.apiKey
  );
  if (usableCredentials.length === 0) {
    throw discoveryError(
      normalizedProvider.vertex
        ? `供应商 ${normalizedProvider.id} 没有可用的 Vertex 凭据引用`
        : `供应商 ${normalizedProvider.id} 没有可用的 API Key`,
      400
    );
  }

  const requestOptions = {
    fetchImpl,
    geminiClientFactory: options.geminiClientFactory || createGeminiClient,
    limit,
    signal: options.signal,
    timeoutMs,
  };
  let lastError = null;
  let sawEmptyList = false;

  for (const credential of usableCredentials) {
    if (options.signal?.aborted) throw abortError();
    try {
      const rawModels =
        normalizedProvider.protocol === "openai"
          ? await fetchOpenAIModels(
              normalizedProvider,
              credential,
              requestOptions
            )
          : normalizedProvider.vertex
            ? await fetchVertexModels(
                normalizedProvider,
                credential,
                requestOptions
              )
            : await fetchGeminiApiModels(
                normalizedProvider,
                credential,
                requestOptions
              );
      const models = normalizeProviderModels(rawModels, limit).filter(
        (model) =>
          !providerSecrets(normalizedProvider).some((secret) =>
            model.includes(secret)
          )
      );
      if (models.length > 0) return models;
      sawEmptyList = true;
    } catch (error) {
      if (error?.name === "AbortError" && options.signal?.aborted) throw error;
      lastError = error;
    }
  }

  if (sawEmptyList) return [];
  throw discoveryError(
    `拉取供应商 ${normalizedProvider.id} 的模型失败：${redactProviderModelError(
      lastError,
      normalizedProvider
    )}`,
    Number(lastError?.status) === 400 ? 400 : 502
  );
}
