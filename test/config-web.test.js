import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { ConfigSchema, getDefaultConfig } from "../src/configSchema.js";
import {
  buildConfigUiSchema,
  startConfigServer,
} from "../src/web/configServer.js";
import {
  isSecretConfigPath,
  maskConfigSecrets,
  restoreConfigSecrets,
  SECRET_MASK,
} from "../src/web/configSecrets.js";
import {
  createArrayItem,
  resolveSelectEmptyOption,
} from "../src/web/frontend/src/lib/config.js";

function readPath(object, key) {
  return String(key || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, part) => value?.[part], object);
}

class FakeConfigManager {
  constructor(config) {
    this.config = ConfigSchema.parse(config);
    this.listeners = new Set();
  }

  get(key) {
    return key ? readPath(this.config, key) : this.config;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRestartRequiredChanges() {
    return [];
  }

  save(raw) {
    const next = ConfigSchema.parse(raw);
    const previous = this.config;
    this.config = next;
    for (const listener of this.listeners) {
      listener(next, { previous, restartRequired: [] });
    }
    return { config: next, restartRequired: [] };
  }
}

function createConfiguredValue() {
  return {
    ...getDefaultConfig(),
    telegram: {
      ...getDefaultConfig().telegram,
      token: "telegram-secret",
      masters: [123],
    },
    redis: {
      ...getDefaultConfig().redis,
      password: "redis-secret",
      execPath: "D:\\Redis\\redis-server.exe",
    },
    web: {
      enabled: true,
      host: "127.0.0.1",
      port: 3457,
      password: "panel-secret",
    },
    ai: {
      ...getDefaultConfig().ai,
      defaultProfile: "sakura",
      roleCards: [
        {
          name: "sakura",
          prompt: "角色设定",
        },
      ],
      profiles: [
        {
          name: "sakura",
          prefixes: ["小樱"],
          keepTriggerPrefix: true,
          route: "default",
          history: true,
          enableNaiPainting: true,
          naiPrompt: "",
          enabled: true,
        },
      ],
      providers: [
        {
          id: "openai",
          protocol: "openai",
          baseURL: "https://example.invalid/v1",
          vertex: false,
          credentials: [
            {
              id: "primary",
              apiKey: "provider-secret",
              serviceAccountRef: "",
              enabled: true,
              priority: 0,
              weight: 1,
            },
          ],
        },
      ],
      routes: [
        {
          id: "default",
          strategy: "priority",
          temperature: -1,
          topP: -1,
          reasoningLevel: "default",
          maxAttempts: 1,
          retryDelayMs: 0,
          targets: [
            {
              id: "primary",
              provider: "openai",
              model: "vision-model",
              enabled: true,
              priority: 0,
              weight: 1,
              temperatureOverride: -1,
              topPOverride: -1,
              openaiEnableThinking: false,
              openaiReasoningEffort: "inherit",
              geminiThinkingLevel: "inherit",
              geminiThinkingBudget: -2,
            },
          ],
        },
      ],
      novelAI: {
        ...getDefaultConfig().ai.novelAI,
        api: "novelai-secret",
      },
    },
  };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function waitForWsMessage(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("等待 WebSocket 消息超时"));
    }, timeoutMs);
    const onMessage = (data) => {
      const payload = JSON.parse(String(data));
      if (!predicate(payload)) return;
      cleanup();
      resolve(payload);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

test("网页配置默认仅监听本机，外部监听必须设置密码", () => {
  const defaults = getDefaultConfig();
  assert.equal(defaults.web.host, "127.0.0.1");
  assert.equal(defaults.web.port, 3457);
  assert.equal(defaults.web.password, "");

  const invalid = ConfigSchema.safeParse({
    web: { enabled: true, host: "0.0.0.0", port: 3457, password: "" },
  });
  assert.equal(invalid.success, false);
  assert.equal(
    invalid.error.issues.some(
      (issue) => issue.path.join(".") === "web.password"
    ),
    true
  );
});

test("密钥遮罩只覆盖仍保留的 Telegram、Redis、Web、文本模型和 NovelAI", () => {
  const config = createConfiguredValue();
  const masked = maskConfigSecrets(config);
  assert.equal(masked.telegram.token, SECRET_MASK);
  assert.equal(masked.redis.password, SECRET_MASK);
  assert.equal(masked.web.password, SECRET_MASK);
  assert.equal(
    masked.ai.providers[0].credentials[0].apiKey,
    SECRET_MASK
  );
  assert.equal(masked.ai.novelAI.api, SECRET_MASK);

  assert.equal(
    isSecretConfigPath(["ai", "novelAI", "api"]),
    true
  );
  assert.equal(
    isSecretConfigPath(["ai", "novelAI", "channels", 0, "api"]),
    false
  );
  assert.equal(isSecretConfigPath(["ai", "image", "channels", 0, "api"]), false);

  const restored = restoreConfigSecrets(masked, config);
  assert.equal(restored.telegram.token, "telegram-secret");
  assert.equal(restored.ai.novelAI.api, "novelai-secret");
  masked.ai.novelAI.api = "";
  assert.equal(
    restoreConfigSecrets(masked, config).ai.novelAI.api,
    ""
  );
});

test("UI schema 只展示基础服务、角色扮演、原生图片输入和 NovelAI", () => {
  const schema = buildConfigUiSchema(new FakeConfigManager(createConfiguredValue()));
  assert.deepEqual(
    schema.categories.map((category) => category.id),
    ["core", "roleplay", "novelai"]
  );
  assert.deepEqual(
    schema.sections.map((section) => section.id),
    [
      "general",
      "telegram",
      "redis",
      "web",
      "ai-general",
      "role-cards",
      "profiles",
      "providers",
      "routes",
      "native-vision",
      "novelai",
    ]
  );
  const serialized = JSON.stringify(schema);
  for (const removed of [
    "toolGroups",
    "toolsRoute",
    "available-tools",
    "nativeWebSearch",
    "supportsImages",
    "groupContext",
    "groupMessage",
    "promptAddons",
    "ai.video",
    "ai.memory",
    "ai.mcp",
    "loliImage",
  ]) {
    assert.equal(serialized.includes(removed), false, removed);
  }

  const redis = schema.sections.find((section) => section.id === "redis");
  const execPath = redis.fields.find((field) => field.key === "execPath");
  assert.equal(execPath.restartRequired, true);
  const nativeVision = schema.sections.find(
    (section) => section.id === "native-vision"
  );
  assert.match(nativeVision.description, /普通模型路由/);

  const novelAI = schema.sections.find((section) => section.id === "novelai");
  for (const removed of ["defaultChannel", "channels"]) {
    assert.equal(
      novelAI.fields.some((field) => field.key === removed),
      false,
      removed
    );
  }
  for (const key of ["model", "baseURL", "api", "checkV5Usage"]) {
    assert.ok(novelAI.fields.some((field) => field.key === key), key);
  }
  assert.equal(
    novelAI.fields.some((field) => field.key === "chatDrawAspectRatio"),
    false
  );
  for (const key of ["chatDrawWidth", "chatDrawHeight"]) {
    const field = novelAI.fields.find((item) => item.key === key);
    assert.equal(field.type, "number");
    assert.equal(field.min, 64);
    assert.equal(field.max, 2048);
    assert.equal(field.step, 64);
    assert.match(field.help, /NovelAI 原生.*64 的倍数/);
  }

  const aiGeneral = schema.sections.find(
    (section) => section.id === "ai-general"
  );
  const defaultProfile = aiGeneral.fields.find(
    (field) => field.key === "defaultProfile"
  );
  assert.equal(defaultProfile.type, "select");
  assert.equal(defaultProfile.allowCustom, false);
  assert.deepEqual(defaultProfile.optionsFrom, {
    paths: ["ai.profiles"],
    valueKey: "name",
  });

  const roleCards = schema.sections.find(
    (section) => section.id === "role-cards"
  );
  assert.deepEqual(
    roleCards.fields.map((field) => field.key),
    ["name", "prompt"]
  );
  assert.deepEqual(
    roleCards.fields.map((field) => field.label),
    ["名字", "角色设定"]
  );
  assert.deepEqual(roleCards.template, { name: "", prompt: "" });

  const profiles = schema.sections.find((section) => section.id === "profiles");
  const selectedRoleCard = profiles.fields.find(
    (field) => field.key === "name"
  );
  assert.equal(selectedRoleCard.type, "select");
  assert.equal(selectedRoleCard.allowEmpty, false);
  assert.equal(selectedRoleCard.allowCustom, false);
  assert.deepEqual(selectedRoleCard.optionsFrom, {
    paths: ["ai.roleCards"],
    valueKey: "name",
  });
  assert.equal(
    profiles.fields.some((field) => field.key === "prompt"),
    false
  );
  assert.equal(Object.hasOwn(profiles.template, "prompt"), false);
  assert.equal(profiles.template.name, "");
  const profileRoute = profiles.fields.find(
    (field) => field.key === "route"
  );
  assert.equal(profileRoute.type, "select");
  assert.equal(profileRoute.allowEmpty, false);
  assert.equal(profileRoute.allowCustom, false);
  assert.deepEqual(profileRoute.optionsFrom, {
    paths: ["ai.routes"],
    valueKey: "id",
  });
  const keepTriggerPrefix = profiles.fields.find(
    (field) => field.key === "keepTriggerPrefix"
  );
  assert.equal(keepTriggerPrefix.type, "boolean");
  assert.match(keepTriggerPrefix.help, /完整提交/);
  assert.equal(
    profiles.fields.some((field) => field.key === "naiChannel"),
    false
  );

  const routes = schema.sections.find((section) => section.id === "routes");
  const targets = routes.fields.find((field) => field.key === "targets");
  const provider = targets.fields.find((field) => field.key === "provider");
  const model = targets.fields.find((field) => field.key === "model");
  assert.deepEqual(provider.clearOnChange, ["model"]);
  assert.equal(provider.type, "select");
  assert.equal(provider.allowEmpty, false);
  assert.equal(provider.allowCustom, false);
  assert.equal(provider.placeholder, "请选择供应商");
  assert.deepEqual(provider.optionsFrom, {
    paths: ["ai.providers"],
    valueKey: "id",
  });
  assert.equal(model.type, "modelSelect");
  assert.equal(model.providerField, "provider");
  assert.equal(model.allowCustom, false);
  assert.match(model.help, /动态加载.*只能从返回结果中选择/);

  const providers = schema.sections.find(
    (section) => section.id === "providers"
  );
  const credentials = providers.fields.find(
    (field) => field.key === "credentials"
  );
  assert.equal(providers.template.id, "");
  assert.equal(providers.template.credentials[0].id, "");
  assert.equal(credentials.template.id, "");
  assert.equal(routes.template.id, "");
  assert.equal(routes.template.targets[0].id, "");
  assert.equal(targets.template.id, "");
  assert.equal(JSON.stringify(schema).includes("new-"), false);
});

test("新增数组表单不会自动填写 new-* 名称或 ID", () => {
  assert.deepEqual(
    createArrayItem(
      {
        itemLabel: "角色卡",
        itemKey: "name",
        template: { name: "", prompt: "" },
      },
      [{ name: "已有角色" }]
    ),
    { name: "", prompt: "" }
  );
});

test("必选下拉框为空时显示占位项而不是伪装成第一项", () => {
  const required = {
    allowEmpty: false,
    placeholder: "请选择供应商",
  };
  assert.deepEqual(resolveSelectEmptyOption(required, ""), {
    label: "请选择供应商",
    disabled: true,
  });
  assert.equal(resolveSelectEmptyOption(required, "provider-1"), null);
  assert.deepEqual(resolveSelectEmptyOption({ allowEmpty: true }, "value"), {
    label: "未选择",
    disabled: false,
  });
});

test("模型列表接口需要认证、恢复遮罩密钥且只返回模型名", async (t) => {
  const manager = new FakeConfigManager(createConfiguredValue());
  let receivedProvider = null;
  let receivedSignal = null;
  let callCount = 0;
  const control = await startConfigServer({
    configManager: manager,
    modelLister: async (provider, options) => {
      callCount += 1;
      receivedProvider = structuredClone(provider);
      receivedSignal = options.signal;
      return ["model-b", "model-a", "model-a", "provider-secret"];
    },
    host: "127.0.0.1",
    port: 0,
    force: true,
    silent: true,
  });
  t.after(() => control.close());

  const draftProvider = maskConfigSecrets(manager.config).ai.providers[0];
  draftProvider.baseURL = "https://draft.example.invalid/v1";
  const unauthorized = await jsonRequest(`${control.url}/api/ai/models`, {
    method: "POST",
    body: JSON.stringify({ provider: draftProvider }),
  });
  assert.equal(unauthorized.response.status, 401);
  assert.equal(callCount, 0);

  const login = await jsonRequest(`${control.url}/api/login`, {
    method: "POST",
    body: JSON.stringify({ password: "panel-secret" }),
  });
  const response = await jsonRequest(`${control.url}/api/ai/models`, {
    method: "POST",
    headers: { Authorization: `Bearer ${login.payload.data.token}` },
    body: JSON.stringify({ provider: draftProvider }),
  });

  assert.equal(response.response.status, 200);
  assert.equal(callCount, 1);
  assert.equal(receivedProvider.baseURL, "https://draft.example.invalid/v1");
  assert.equal(receivedProvider.credentials[0].apiKey, "provider-secret");
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.deepEqual(response.payload.data, {
    providerId: "openai",
    models: ["model-a", "model-b"],
  });
  const serialized = JSON.stringify(response.payload);
  assert.equal(serialized.includes("provider-secret"), false);
  assert.equal(serialized.includes("apiKey"), false);
  assert.equal(serialized.includes("credentials"), false);
});

test("WebSocket 只推送配置版本，不广播配置正文", async (t) => {
  const manager = new FakeConfigManager(createConfiguredValue());
  const control = await startConfigServer({
    configManager: manager,
    host: "127.0.0.1",
    port: 0,
    force: true,
    silent: true,
  });
  t.after(() => control.close());

  const login = await jsonRequest(`${control.url}/api/login`, {
    method: "POST",
    body: JSON.stringify({ password: "panel-secret" }),
  });
  const token = login.payload.data.token;
  const ws = new WebSocket(
    control.url.replace(/^http/, "ws") + `/ws?token=${token}`
  );
  t.after(() => ws.close());
  const ready = await waitForWsMessage(ws, (message) => message.type === "ready");
  assert.ok(ready.revision);
  assert.equal(JSON.stringify(ready).includes("telegram-secret"), false);

  const changedPromise = waitForWsMessage(
    ws,
    (message) => message.type === "config_changed"
  );
  manager.save({ ...manager.config, logLevel: "debug" });
  const changed = await changedPromise;
  assert.ok(changed.revision);
  assert.equal(JSON.stringify(changed).includes("provider-secret"), false);
  assert.equal(Object.hasOwn(changed, "config"), false);
});

test("配置 API 登录、密钥保护、校验、版本冲突和已移除端点", async (t) => {
  const manager = new FakeConfigManager(createConfiguredValue());
  const control = await startConfigServer({
    configManager: manager,
    host: "127.0.0.1",
    port: 0,
    force: true,
    silent: true,
  });
  t.after(() => control.close());

  const session = await jsonRequest(`${control.url}/api/session`);
  assert.equal(session.response.status, 200);
  assert.equal(session.payload.data.authRequired, true);
  assert.equal(session.payload.data.authenticated, false);

  const wrong = await jsonRequest(`${control.url}/api/login`, {
    method: "POST",
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.equal(wrong.response.status, 401);

  const login = await jsonRequest(`${control.url}/api/login`, {
    method: "POST",
    body: JSON.stringify({ password: "panel-secret" }),
  });
  assert.equal(login.response.status, 200);
  const headers = { Authorization: `Bearer ${login.payload.data.token}` };

  const removedToolsEndpoint = await jsonRequest(
    `${control.url}/api/available-tools`,
    { headers }
  );
  assert.equal(removedToolsEndpoint.response.status, 404);

  const configResponse = await jsonRequest(`${control.url}/api/config`, {
    headers,
  });
  assert.equal(configResponse.response.status, 200);
  assert.equal(configResponse.payload.data.telegram.token, SECRET_MASK);
  assert.equal(
    configResponse.payload.data.ai.providers[0].credentials[0].apiKey,
    SECRET_MASK
  );
  assert.equal(
    configResponse.payload.data.ai.novelAI.api,
    SECRET_MASK
  );

  const next = structuredClone(configResponse.payload.data);
  next.logLevel = "debug";
  const saved = await jsonRequest(`${control.url}/api/config`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      data: next,
      revision: configResponse.payload.revision,
    }),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(manager.config.logLevel, "debug");
  assert.equal(manager.config.telegram.token, "telegram-secret");
  assert.equal(
    manager.config.ai.novelAI.api,
    "novelai-secret"
  );

  const conflict = await jsonRequest(`${control.url}/api/config`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      data: next,
      revision: configResponse.payload.revision,
    }),
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.payload.code, "REVISION_CONFLICT");

  const invalid = structuredClone(saved.payload.data);
  invalid.web.host = "0.0.0.0";
  invalid.web.password = "";
  const invalidResponse = await jsonRequest(`${control.url}/api/config`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      data: invalid,
      revision: saved.payload.revision,
    }),
  });
  assert.equal(invalidResponse.response.status, 422);
  assert.equal(
    invalidResponse.payload.errors.some(
      (issue) => issue.path.join(".") === "web.password"
    ),
    true
  );

  const page = await fetch(control.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SakuraTG 配置中心/);
  assert.match(
    page.headers.get("content-security-policy") || "",
    /default-src 'self'/
  );
});
