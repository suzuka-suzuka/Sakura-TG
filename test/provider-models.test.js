import test from "node:test";
import assert from "node:assert/strict";

import { listProviderModels } from "../src/ai/providerModels.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function openAIProvider(credentials) {
  return {
    id: "openai-test",
    protocol: "openai",
    baseURL: "https://models.example.test/v1/",
    vertex: false,
    credentials,
  };
}

test("OpenAI 模型端点按凭据优先级回退，并去重排序模型", async () => {
  const calls = [];
  const provider = openAIProvider([
    {
      id: "disabled",
      apiKey: "disabled-secret",
      enabled: false,
      priority: 100,
    },
    { id: "fallback", apiKey: "fallback-secret", enabled: true, priority: 0 },
    { id: "primary", apiKey: "primary-secret", enabled: true, priority: 10 },
  ]);

  const models = await listProviderModels(provider, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.Authorization });
      if (init.headers.Authorization === "Bearer primary-secret") {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse({
        data: [
          { id: "gpt-10" },
          { id: "gpt-2" },
          { id: "gpt-2" },
          { id: "" },
        ],
      });
    },
  });

  assert.deepEqual(models, ["gpt-2", "gpt-10"]);
  assert.deepEqual(
    calls.map((call) => call.authorization),
    ["Bearer primary-secret", "Bearer fallback-secret"]
  );
  assert.equal(calls.every((call) => call.url === "https://models.example.test/v1/models"), true);
  assert.equal(JSON.stringify(calls).includes("disabled-secret"), false);
});

test("Gemini 模型端点读取分页、规范化名称并排除非生成模型", async () => {
  const calls = [];
  const provider = {
    id: "gemini-test",
    protocol: "gemini",
    baseURL: "https://gemini.example.test",
    vertex: false,
    credentials: [
      { id: "primary", apiKey: "gemini-secret", enabled: true, priority: 0 },
    ],
  };

  const models = await listProviderModels(provider, {
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({
        pathname: parsed.pathname,
        pageSize: parsed.searchParams.get("pageSize"),
        pageToken: parsed.searchParams.get("pageToken"),
        apiKey: init.headers["x-goog-api-key"],
      });
      if (!parsed.searchParams.has("pageToken")) {
        return jsonResponse({
          models: [
            {
              name: "models/gemini-2",
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/text-embedding",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
          nextPageToken: "next-page",
        });
      }
      return jsonResponse({
        models: [
          { name: "publishers/google/models/gemini-10" },
          { name: "models/gemini-2" },
        ],
      });
    },
  });

  assert.deepEqual(models, ["gemini-2", "gemini-10"]);
  assert.deepEqual(calls, [
    {
      pathname: "/v1beta/models",
      pageSize: "100",
      pageToken: null,
      apiKey: "gemini-secret",
    },
    {
      pathname: "/v1beta/models",
      pageSize: "100",
      pageToken: "next-page",
      apiKey: "gemini-secret",
    },
  ]);
});

test("Vertex 模型列表通过服务账号客户端读取", async () => {
  let clientConfig;
  let listConfig;
  const provider = {
    id: "vertex-test",
    protocol: "gemini",
    baseURL: "",
    vertex: true,
    credentials: [
      {
        id: "vertex",
        apiKey: "",
        serviceAccountRef: "vertex-primary",
        enabled: true,
        priority: 0,
      },
    ],
  };

  const models = await listProviderModels(provider, {
    fetchImpl: async () => {
      throw new Error("Vertex 不应使用普通 fetch 模型端点");
    },
    geminiClientFactory(config) {
      clientConfig = config;
      return {
        models: {
          async list(params) {
            listConfig = params.config;
            return {
              async *[Symbol.asyncIterator]() {
                yield { name: "publishers/google/models/gemini-vertex" };
              },
            };
          },
        },
      };
    },
  });

  assert.deepEqual(models, ["gemini-vertex"]);
  assert.equal(clientConfig.serviceAccountRef, "vertex-primary");
  assert.equal(clientConfig.vertex, true);
  assert.equal(listConfig.pageSize, 100);
  assert.ok(listConfig.abortSignal instanceof AbortSignal);
});

test("模型发现失败信息不会泄露 API Key", async () => {
  const provider = openAIProvider([
    { id: "primary", apiKey: "super-secret-key", enabled: true, priority: 0 },
  ]);

  await assert.rejects(
    () =>
      listProviderModels(provider, {
        fetchImpl: async () => {
          throw new Error(
            "Authorization: Bearer super-secret-key https://bad.test/?key=super-secret-key"
          );
        },
      }),
    (error) => {
      assert.match(error.message, /拉取供应商 openai-test 的模型失败/);
      assert.equal(error.message.includes("super-secret-key"), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );
});

test("模型端点超时会给出明确错误", async () => {
  const provider = openAIProvider([
    { id: "primary", apiKey: "timeout-secret", enabled: true, priority: 0 },
  ]);

  await assert.rejects(
    () =>
      listProviderModels(provider, {
        timeoutMs: 100,
        fetchImpl: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true }
            );
          }),
      }),
    /模型列表请求超时（100 毫秒）/
  );
});
