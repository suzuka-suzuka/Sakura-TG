import test from "node:test";
import assert from "node:assert/strict";

import { parseNovelAICommandArgs } from "../src/ai/media/novelAICommand.js";
import {
  appendNovelAIQualityTags,
  buildNovelAIRequest,
  checkNovelAIUsageLimit,
  getNovelAIModelProfile,
  requestNovelAIImages,
  requestNovelAIImagesWithRetry,
} from "../src/ai/media/novelAIProvider.js";
import { normalizeNovelAIVibeName } from "../src/ai/media/novelAIVibeStore.js";

const IMAGE_ARCHIVE = Buffer.from(
  "UEsDBBQABgAIAJu0GV1ug/RURAAAAEQAAAALAAAAaW1hZ2VfMC5wbmfrDPBz5+WS4mJgYOD19HAJYmBgYARhDhYGBoatMjxMDAwM3J4ujiEVt5L//JdnYHrN+DWzbE4KAwMDg6ern8s6p4QmAFBLAQIUABQABgAIAJu0GV1ug/RURAAAAEQAAAALAAAAAAAAAAAAAAAAAAAAAABpbWFnZV8wLnBuZ1BLBQYAAAAAAQABADkAAABtAAAAAAA=",
  "base64"
);

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
}

function successImageResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(IMAGE_ARCHIVE.length) },
    body: null,
    async arrayBuffer() {
      return toArrayBuffer(IMAGE_ARCHIVE);
    },
  };
}

function errorResponse(status, detail) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    async text() {
      return detail;
    },
  };
}

function redisMock({ value = null, ttl = -2 } = {}) {
  const calls = [];
  return {
    calls,
    async get(key) {
      calls.push(["get", key]);
      return value;
    },
    async ttl(key) {
      calls.push(["ttl", key]);
      return ttl;
    },
    async set(...args) {
      calls.push(["set", ...args]);
      return "OK";
    },
  };
}

test("NAI 绘图指令解析画风、画幅和连续角色坐标", () => {
  const vibe = {
    name: "梦幻可爱",
    image: "encoded-vibe",
    strength: 0.6,
    informationExtracted: 0.7,
  };
  const parsed = parseNovelAICommandArgs(
    "梦幻可爱 横 [@12.5,80: 1girl, blue hair] [右: 1boy] cherry blossoms",
    {
      vibes: [vibe],
      resolveVibe: () => vibe,
    }
  );
  assert.equal(Object.hasOwn(parsed, "channel"), false);
  assert.equal(parsed.vibeData, vibe);
  assert.equal(parsed.width, 1216);
  assert.equal(parsed.height, 832);
  assert.equal(parsed.prompt, "cherry blossoms");
  assert.deepEqual(parsed.characters[0].center, { x: 0.125, y: 0.8 });
  assert.deepEqual(parsed.characters[1].center, { x: 0.7, y: 0.5 });
});

test("画风名称拒绝路径穿越和 Windows 非法字符", () => {
  assert.equal(normalizeNovelAIVibeName("梦幻可爱"), "梦幻可爱");
  assert.throws(() => normalizeNovelAIVibeName("../secret"), /不合法/);
  assert.throws(() => normalizeNovelAIVibeName("bad:name"), /不合法/);
});

test("NAI5 使用 params_version 4、连续坐标和透明背景提示", () => {
  assert.equal(getNovelAIModelProfile("nai-diffusion-5-full").family, "v5");
  const payload = buildNovelAIRequest({
    channel: {
      model: "nai-diffusion-5-full",
      qualityTags: "very aesthetic, masterpiece, no text",
    },
    prompt: "2girls, transparent background",
    parameters: { params_version: 3 },
    characters: [
      { prompt: "1girl, blue hair", center: { x: 0.12, y: 0.8 } },
      { prompt: "1girl, red hair", center: { x: 0.74, y: 0.2 } },
    ],
  });
  assert.equal(payload.parameters.params_version, 4);
  assert.equal(payload.parameters.scale, 7);
  assert.equal(payload.parameters.steps, 28);
  assert.equal(payload.parameters.tag_hint_transparent_background, true);
  assert.deepEqual(payload.parameters.characterPrompts[0].center, {
    x: 0.12,
    y: 0.8,
  });
  assert.equal(payload.parameters.use_coords, true);
});

test("NAI 请求直接使用显式 NovelAI 宽高", () => {
  const payload = buildNovelAIRequest({
    channel: {
      model: "nai-diffusion-5-full",
      width: 832,
      height: 1216,
      qualityTags: "",
    },
    prompt: "1girl",
    parameters: { width: 1216, height: 832 },
  });

  assert.equal(payload.parameters.width, 1216);
  assert.equal(payload.parameters.height, 832);
});

test("可见文字请求去除 no text 并把 Text 块留在末尾", () => {
  const prompt = appendNovelAIQualityTags(
    "1girl, chinese text, no text, Text: 你好",
    "very aesthetic, masterpiece, no text"
  );
  assert.equal(
    prompt,
    "1girl, chinese text, very aesthetic, masterpiece\nText: 你好"
  );
});

test("V4.5 角色位置吸附到官方 5x5 网格", () => {
  const payload = buildNovelAIRequest({
    channel: { model: "nai-diffusion-4-5-full", qualityTags: "" },
    prompt: "1girl",
    characters: [
      { prompt: "1girl, blue hair", center: { x: 0.12, y: 0.8 } },
    ],
  });
  assert.equal(payload.parameters.params_version, 4);
  assert.equal(payload.parameters.scale, 5);
  assert.deepEqual(payload.parameters.characterPrompts[0].center, {
    x: 0.1,
    y: 0.9,
  });
});

test("NAI5 用量等于 5% 时写入冷却并保留订阅信息", async () => {
  const redisClient = redisMock();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        tier: 3,
        active: true,
        usage: {
          percent: 5,
          isNegative: false,
          timeUntilNextPercent: 120,
        },
      };
    },
  });

  await assert.rejects(
    checkNovelAIUsageLimit("test-token", {
      redisClient,
      fetchImpl,
      subscriptionURL: "https://example.test/user/subscription",
    }),
    (error) => {
      assert.equal(error.code, "NAI_USAGE_LIMIT");
      assert.equal(error.subscriptionTier, 3);
      assert.equal(error.subscriptionActive, true);
      assert.match(error.message, /5%.*2 分钟/);
      return true;
    }
  );
  const setCall = redisClient.calls.find(([operation]) => operation === "set");
  assert.ok(setCall);
  assert.equal(setCall[3], "EX");
  assert.equal(setCall[4], 120);
  assert.doesNotMatch(setCall[1], /test-token/);
});

test("NAI5 低用量的单张文生图安全回退 V4.5", async () => {
  let generationPayload = null;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/user/subscription")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            tier: 3,
            active: true,
            usage: {
              percent: 5,
              isNegative: false,
              timeUntilNextPercent: 120,
            },
          };
        },
      };
    }
    generationPayload = JSON.parse(options.body);
    return successImageResponse();
  };

  const images = await requestNovelAIImages({
    channel: {
      model: "nai-diffusion-5-full",
      baseURL: "https://example.test",
      qualityTags: "masterpiece, no text",
      scale: 7,
      steps: 28,
    },
    apiKey: "test-token",
    prompt: "1girl",
    redisClient: redisMock(),
    fetchImpl,
    retryDelaysMs: [],
  });
  assert.equal(images.length, 1);
  assert.equal(generationPayload.model, "nai-diffusion-4-5-full");
  assert.equal(generationPayload.parameters.params_version, 4);
  assert.equal(generationPayload.parameters.scale, 5);
});

test("Vibe 在 NAI5 配置下直接回退 V4.5 且不查询 V5 用量", async () => {
  let subscriptionCalls = 0;
  let generationPayload = null;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/user/subscription")) {
      subscriptionCalls += 1;
      throw new Error("不应查询 V5 用量");
    }
    generationPayload = JSON.parse(options.body);
    return successImageResponse();
  };
  await requestNovelAIImages({
    channel: {
      model: "nai-diffusion-5-full",
      baseURL: "https://example.test",
      qualityTags: "masterpiece, no text",
      scale: 7,
      steps: 28,
    },
    apiKey: "test-token",
    prompt: "1girl",
    parameters: {
      reference_image_multiple: ["encoded-vibe"],
      reference_information_extracted_multiple: [0.7],
      reference_strength_multiple: [0.6],
    },
    fetchImpl,
    retryDelaysMs: [],
  });
  assert.equal(subscriptionCalls, 0);
  assert.equal(generationPayload.model, "nai-diffusion-4-5-full");
  assert.deepEqual(generationPayload.parameters.reference_image_multiple, [
    "encoded-vibe",
  ]);
});

test("Vibe 回退遇到底图时在请求前停止，避免消耗 Anlas", async () => {
  let calls = 0;
  await assert.rejects(
    requestNovelAIImages({
      channel: {
        model: "nai-diffusion-5-full",
        baseURL: "https://example.test",
      },
      apiKey: "test-token",
      prompt: "1girl",
      sources: [{ buffer: Buffer.from("source") }],
      parameters: { reference_image_multiple: ["encoded-vibe"] },
      fetchImpl: async () => {
        calls += 1;
        return successImageResponse();
      },
      retryDelaysMs: [],
    }),
    /包含底图.*避免消耗 Anlas/
  );
  assert.equal(calls, 0);
});

test("网络异常和 429 按 10、20、30 秒退避后复用同一请求", async () => {
  const delays = [];
  const warnings = [];
  const bodies = [];
  let calls = 0;
  const images = await requestNovelAIImagesWithRetry({
    endpoint: "https://example.test/ai/generate-image",
    apiKey: "test-token",
    payload: { input: "1girl" },
    fetchImpl: async (_url, options) => {
      calls += 1;
      bodies.push(options.body);
      if (calls === 1) {
        throw new TypeError("terminated", {
          cause: { code: "UND_ERR_SOCKET" },
        });
      }
      if (calls === 2) return errorResponse(429, "rate limited");
      if (calls === 3) {
        throw Object.assign(new Error("connect timeout"), {
          code: "ETIMEDOUT",
        });
      }
      return successImageResponse();
    },
    retryDelaysMs: [10_000, 20_000, 30_000],
    waitImpl: async (delay) => delays.push(delay),
    onRetry: (warning) => warnings.push(warning),
  });
  assert.equal(images.length, 1);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [10_000, 20_000, 30_000]);
  assert.equal(new Set(bodies).size, 1);
  assert.match(warnings[1], /HTTP 429.*20 秒后进行第 2\/3 次重试/);
});

test("NAI 参数错误不会重试", async () => {
  const delays = [];
  let calls = 0;
  await assert.rejects(
    requestNovelAIImagesWithRetry({
      endpoint: "https://example.test/ai/generate-image",
      apiKey: "test-token",
      payload: { input: "bad" },
      fetchImpl: async () => {
        calls += 1;
        return errorResponse(400, "bad request");
      },
      waitImpl: async (delay) => delays.push(delay),
    }),
    /HTTP 400 bad request/
  );
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});
