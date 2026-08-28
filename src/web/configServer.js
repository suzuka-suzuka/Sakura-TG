import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import Config, { RESTART_REQUIRED } from "../config.js";
import { ConfigSchema } from "../configSchema.js";
import { resolveConfigValue } from "../ai/configValue.js";
import {
  listProviderModels,
  normalizeProviderModels,
  redactProviderModelError,
} from "../ai/providerModels.js";
import { logger } from "../logger.js";
import {
  maskConfigSecrets,
  restoreConfigSecrets,
  SECRET_MASK,
} from "./configSecrets.js";
import { CONFIG_UI_SCHEMA } from "./configUiSchema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.join(__dirname, "public");
const MAX_REQUEST_BODY_SIZE = 2 * 1024 * 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
const MAX_SESSIONS = 128;
const WS_HEARTBEAT_MS = 30 * 1000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export function buildConfigUiSchema(_configManager = Config) {
  return structuredClone(CONFIG_UI_SCHEMA);
}

function securityHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra,
  };
}

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(
    status,
    securityHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    })
  );
  res.end(body);
}

function sendEmpty(res, status = 204) {
  res.writeHead(status, securityHeaders());
  res.end();
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    let tooLarge = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_REQUEST_BODY_SIZE) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (tooLarge) {
        const error = new Error("请求体不能超过 2 MB");
        error.status = 413;
        reject(error);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        const error = new Error("请求体不是有效的 JSON");
        error.status = 400;
        reject(error);
      }
    });
    req.on("error", fail);
  });
}

function getBearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  return match?.[1]?.trim() || "";
}

function safeCompare(left, right) {
  const leftBuffer = crypto
    .createHash("sha256")
    .update(String(left))
    .digest();
  const rightBuffer = crypto
    .createHash("sha256")
    .update(String(right))
    .digest();
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || "").trim().toLowerCase());
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      parsed.host === req.headers.host
    );
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, status, message) {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body
  );
  socket.destroy();
}

function formatIssues(issues = []) {
  return issues.map((issue) => ({
    path: issue.path.map(String),
    message: issue.message,
    code: issue.code,
  }));
}

function boundedString(value, maxLength, label) {
  const normalized = String(value ?? "");
  if (normalized.length > maxLength) {
    const error = new Error(`${label}长度不能超过 ${maxLength} 个字符`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

function normalizeProviderDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("缺少供应商配置");
    error.status = 400;
    throw error;
  }
  if (value.credentials !== undefined && !Array.isArray(value.credentials)) {
    const error = new Error("供应商凭据格式不正确");
    error.status = 400;
    throw error;
  }
  const credentials = Array.isArray(value.credentials) ? value.credentials : [];
  if (credentials.length > 100) {
    const error = new Error("单个供应商最多配置 100 个凭据");
    error.status = 400;
    throw error;
  }

  return {
    id: boundedString(value.id, 128, "供应商 ID").trim(),
    protocol: boundedString(value.protocol, 32, "供应商协议").trim(),
    baseURL: boundedString(value.baseURL, 2048, "API 地址").trim(),
    vertex: value.vertex === true,
    credentials: credentials.map((credential, index) => {
      if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
        const error = new Error(`第 ${index + 1} 个供应商凭据格式不正确`);
        error.status = 400;
        throw error;
      }
      return {
        id: boundedString(credential.id, 128, "凭据 ID").trim(),
        apiKey: boundedString(credential.apiKey, 8192, "API Key"),
        serviceAccountRef: boundedString(
          credential.serviceAccountRef,
          256,
          "Vertex 凭据引用"
        ).trim(),
        enabled: credential.enabled !== false,
        priority: credential.priority,
        weight: credential.weight,
      };
    }),
  };
}

function restoreProviderDraftSecrets(provider, currentConfig) {
  const currentProvider = (currentConfig?.ai?.providers || []).find(
    (item) => item?.id === provider.id
  );
  const currentCredentials = new Map(
    (currentProvider?.credentials || []).map((credential) => [
      credential?.id,
      credential,
    ])
  );
  const alignedCurrentProvider = {
    ...(currentProvider || {}),
    credentials: provider.credentials.map(
      (credential) => currentCredentials.get(credential.id) || {}
    ),
  };
  const restored = restoreConfigSecrets(
    { ai: { providers: [provider] } },
    { ai: { providers: [alignedCurrentProvider] } }
  ).ai.providers[0];

  return {
    ...restored,
    credentials: restored.credentials.map((credential) => ({
      ...credential,
      apiKey: credential.apiKey === SECRET_MASK ? "" : credential.apiKey,
    })),
  };
}

function publicModelList(result, provider) {
  const rawModels = Array.isArray(result) ? result : result?.models;
  const secrets = (provider.credentials || [])
    .map((credential) => String(resolveConfigValue(credential.apiKey) || ""))
    .filter(Boolean);
  return normalizeProviderModels(rawModels).filter(
    (model) => !secrets.some((secret) => model.includes(secret))
  );
}

function resolveStaticPath(publicDir, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname === "/" ? "index.html" : pathname.slice(1));
  } catch {
    return null;
  }

  if (!relative || relative.includes("\0")) return null;
  const root = path.resolve(publicDir);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

function serveStatic(req, res, publicDir, pathname) {
  if (!["GET", "HEAD"].includes(req.method)) {
    sendJson(res, { success: false, error: "方法不允许" }, 405);
    return;
  }

  const filePath = resolveStaticPath(publicDir, pathname);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, { success: false, error: "页面不存在" }, 404);
    return;
  }

  const stat = fs.statSync(filePath);
  res.writeHead(
    200,
    securityHeaders({
      "Content-Type":
        MIME_TYPES[path.extname(filePath).toLowerCase()] ||
        "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    })
  );

  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

/**
 * 创建配置面板 HTTP 服务。configManager 可注入，便于不触碰真实配置地测试接口。
 */
export function createConfigHttpServer({
  configManager = Config,
  publicDir = DEFAULT_PUBLIC_DIR,
  sessionTtlMs = SESSION_TTL_MS,
  modelLister = listProviderModels,
} = {}) {
  const sessions = new Map();
  const loginFailures = new Map();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
  });
  let revision = crypto.randomUUID();
  let disposed = false;
  let changeContext = null;

  const getWebConfig = () => configManager.get("web") || {};
  const getPassword = () =>
    String(resolveConfigValue(getWebConfig().password) || "");
  const authRequired = () => getPassword().length > 0;

  const cleanupSessions = () => {
    const now = Date.now();
    for (const [tokenHash, session] of sessions.entries()) {
      if (session.expiresAt <= now) sessions.delete(tokenHash);
    }
  };

  const createSession = () => {
    cleanupSessions();
    while (sessions.size >= MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + sessionTtlMs;
    sessions.set(hashToken(token), {
      expiresAt,
      passwordHash: hashToken(getPassword()),
    });
    return { token, expiresAt };
  };

  const verifyToken = (token, touch = false) => {
    if (!token) return null;
    cleanupSessions();
    const key = hashToken(token);
    const session = sessions.get(key);
    if (!session) return null;
    if (session.passwordHash !== hashToken(getPassword())) {
      sessions.delete(key);
      return null;
    }
    if (touch) session.expiresAt = Date.now() + sessionTtlMs;
    return session;
  };

  const requireAuth = (req, res) => {
    if (!authRequired()) return true;
    if (verifyToken(getBearerToken(req), true)) return true;
    sendJson(
      res,
      { success: false, error: "请重新登录", code: "UNAUTHORIZED" },
      401
    );
    return false;
  };

  const clientKey = (req) =>
    String(req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");

  const loginBlocked = (req) => {
    const key = clientKey(req);
    const entry = loginFailures.get(key);
    if (!entry || entry.resetAt <= Date.now()) {
      loginFailures.delete(key);
      return false;
    }
    return entry.count >= MAX_LOGIN_FAILURES;
  };

  const recordLoginFailure = (req) => {
    const key = clientKey(req);
    const now = Date.now();
    const current = loginFailures.get(key);
    if (!current || current.resetAt <= now) {
      loginFailures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return;
    }
    current.count += 1;
  };

  const clearLoginFailures = (req) => loginFailures.delete(clientKey(req));

  const closeWebSockets = (code = 1001, reason = "Server closing") => {
    for (const client of wss.clients) {
      try {
        client.close(code, reason);
      } catch {
        client.terminate();
      }
    }
  };

  const broadcast = (payload) => {
    const message = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (
        authRequired() &&
        !verifyToken(client.sessionToken || "", false)
      ) {
        client.close(1008, "Session expired");
        continue;
      }
      client.send(message);
    }
  };

  const unsubscribe = configManager.onChange?.((next, meta = {}) => {
    revision = crypto.randomUUID();
    const passwordChanged =
      next?.web?.password !== meta.previous?.web?.password;
    if (passwordChanged) {
      sessions.clear();
      closeWebSockets(1008, "Password updated");
      return;
    }
    broadcast({
      type: "config_changed",
      revision,
      restartRequired: meta.restartRequired || [],
      source: changeContext ? "web" : "external",
      requestId: changeContext?.requestId || null,
      timestamp: Date.now(),
    });
  });

  const handleApi = async (req, res, pathname) => {
    if (!isSameOrigin(req)) {
      sendJson(res, { success: false, error: "拒绝跨站请求" }, 403);
      return;
    }

    if (req.method === "OPTIONS") {
      sendEmpty(res);
      return;
    }

    if (pathname === "/api/session" && req.method === "GET") {
      const required = authRequired();
      const session = required
        ? verifyToken(getBearerToken(req), true)
        : { expiresAt: null };
      sendJson(res, {
        success: true,
        data: {
          authRequired: required,
          authenticated: !required || Boolean(session),
          expiresAt: session?.expiresAt ?? null,
        },
      });
      return;
    }

    if (pathname === "/api/login" && req.method === "POST") {
      if (!authRequired()) {
        sendJson(res, {
          success: true,
          data: { token: "", expiresAt: null, authRequired: false },
        });
        return;
      }
      if (loginBlocked(req)) {
        sendJson(
          res,
          { success: false, error: "尝试次数过多，请一分钟后再试" },
          429
        );
        return;
      }

      const body = await parseJsonBody(req);
      if (!safeCompare(body.password || "", getPassword())) {
        recordLoginFailure(req);
        sendJson(res, { success: false, error: "密码不正确" }, 401);
        return;
      }

      clearLoginFailures(req);
      const session = createSession();
      sendJson(res, {
        success: true,
        data: { ...session, authRequired: true },
      });
      return;
    }

    if (pathname === "/api/logout" && req.method === "POST") {
      const token = getBearerToken(req);
      if (token) sessions.delete(hashToken(token));
      sendJson(res, { success: true });
      return;
    }

    if (!requireAuth(req, res)) return;

    if (pathname === "/api/schema" && req.method === "GET") {
      sendJson(res, {
        success: true,
        data: {
          ...buildConfigUiSchema(configManager),
          secretMask: SECRET_MASK,
        },
      });
      return;
    }

    if (pathname === "/api/config" && req.method === "GET") {
      sendJson(res, {
        success: true,
        data: maskConfigSecrets(configManager.get()),
        revision,
        restartRequiredPaths: RESTART_REQUIRED,
      });
      return;
    }

    if (pathname === "/api/ai/models" && req.method === "POST") {
      const body = await parseJsonBody(req);
      let provider;
      try {
        provider = restoreProviderDraftSecrets(
          normalizeProviderDraft(body?.provider),
          configManager.get()
        );
      } catch (error) {
        sendJson(res, { success: false, error: error.message }, 400);
        return;
      }

      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      req.once("aborted", abortRequest);
      try {
        const result = await modelLister(provider, {
          signal: requestController.signal,
        });
        if (requestController.signal.aborted || res.destroyed) return;
        sendJson(res, {
          success: true,
          data: {
            providerId: provider.id,
            models: publicModelList(result, provider),
          },
        });
      } catch (error) {
        if (requestController.signal.aborted || res.destroyed) return;
        const message = redactProviderModelError(error, provider);
        logger.warn(
          `[ConfigWeb] 拉取 AI 模型列表失败 provider=${JSON.stringify(
            provider.id
          )} error=${JSON.stringify(message)}`
        );
        sendJson(
          res,
          { success: false, error: message || "模型列表加载失败" },
          Number(error?.status) === 400 ? 400 : 502
        );
      } finally {
        req.off("aborted", abortRequest);
      }
      return;
    }

    if (pathname === "/api/config" && req.method === "POST") {
      const body = await parseJsonBody(req);
      if (!body || typeof body.data !== "object" || Array.isArray(body.data)) {
        sendJson(res, { success: false, error: "缺少配置数据" }, 400);
        return;
      }
      if (body.revision !== revision) {
        sendJson(
          res,
          {
            success: false,
            error: "配置已在其他位置修改，请重新载入后再保存",
            code: "REVISION_CONFLICT",
          },
          409
        );
        return;
      }

      const restored = restoreConfigSecrets(body.data, configManager.get());
      const parsed = ConfigSchema.safeParse(restored);
      if (!parsed.success) {
        sendJson(
          res,
          {
            success: false,
            error: "配置校验失败",
            errors: formatIssues(parsed.error.issues),
          },
          422
        );
        return;
      }

      const requestId =
        typeof body.requestId === "string" && body.requestId.length <= 128
          ? body.requestId
          : null;
      let result;
      changeContext = { requestId };
      try {
        result = configManager.save(parsed.data);
      } finally {
        changeContext = null;
      }
      sendJson(res, {
        success: true,
        data: maskConfigSecrets(result.config),
        revision,
        restartRequired: result.restartRequired || [],
      });
      return;
    }

    if (pathname === "/api/status" && req.method === "GET") {
      sendJson(res, {
        success: true,
        data: {
          uptimeSeconds: Math.floor(process.uptime()),
          nodeVersion: process.version,
          revision,
          authRequired: authRequired(),
          listen: {
            host: getWebConfig().host,
            port: getWebConfig().port,
          },
        },
      });
      return;
    }

    sendJson(res, { success: false, error: "接口不存在" }, 404);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url.pathname);
      } else {
        serveStatic(req, res, publicDir, url.pathname);
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = Number(error?.status) || 500;
      if (status >= 500) {
        logger.error(`[ConfigWeb] 请求处理失败: ${error.message}`);
      }
      sendJson(
        res,
        {
          success: false,
          error: status >= 500 ? "服务器处理请求失败" : error.message,
        },
        status
      );
    }
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }

    if (url.pathname !== "/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!isSameOrigin(req)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    const token = url.searchParams.get("token") || "";
    if (authRequired() && !verifyToken(token, true)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      client.sessionToken = token;
      wss.emit("connection", client, req);
    });
  });

  wss.on("connection", (client) => {
    client.isAlive = true;
    client.on("pong", () => {
      client.isAlive = true;
      if (authRequired()) verifyToken(client.sessionToken || "", true);
    });
    client.on("error", () => {
      client.terminate();
    });
    client.send(
      JSON.stringify({
        type: "ready",
        revision,
        timestamp: Date.now(),
      })
    );
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (
        client.isAlive === false ||
        (authRequired() && !verifyToken(client.sessionToken || "", false))
      ) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, WS_HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    server,
    wss,
    get revision() {
      return revision;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      closeWebSockets();
      wss.close();
      sessions.clear();
      loginFailures.clear();
    },
  };
}

export async function startConfigServer({
  configManager = Config,
  publicDir = DEFAULT_PUBLIC_DIR,
  modelLister = listProviderModels,
  host,
  port,
  force = false,
  silent = false,
} = {}) {
  const web = configManager.get("web") || {};
  if (!force && web.enabled === false) return null;

  const listenHost = host ?? web.host ?? "127.0.0.1";
  const listenPort = port ?? web.port ?? 3457;
  const password = String(resolveConfigValue(web.password) || "");

  if (!isLoopbackHost(listenHost) && !password) {
    throw new Error("配置面板监听非本机地址时必须设置有效登录密码");
  }

  const control = createConfigHttpServer({
    configManager,
    publicDir,
    modelLister,
  });
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        control.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        control.server.off("error", onError);
        resolve();
      };
      control.server.once("error", onError);
      control.server.once("listening", onListening);
      control.server.listen(listenPort, listenHost);
    });
  } catch (error) {
    control.dispose();
    throw error;
  }

  const address = control.server.address();
  const actualPort =
    address && typeof address === "object" ? address.port : listenPort;
  const displayHost = isLoopbackHost(listenHost) ? listenHost : "127.0.0.1";
  const url = `http://${displayHost.includes(":") ? `[${displayHost}]` : displayHost}:${actualPort}`;

  if (!silent) {
    logger.info(`[ConfigWeb] 配置面板已启动: ${url}`);
    if (!password) {
      logger.warn("[ConfigWeb] 当前未设置登录密码，仅适合本机访问");
    }
  }

  return {
    ...control,
    host: listenHost,
    port: actualPort,
    url,
    get revision() {
      return control.revision;
    },
    async close() {
      control.dispose();
      if (!control.server.listening) return;
      await new Promise((resolve, reject) => {
        control.server.close((error) => (error ? reject(error) : resolve()));
        control.server.closeIdleConnections?.();
      });
    },
  };
}
