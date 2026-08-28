import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clone, withValueAtPath } from "../lib/config.js";
import useConfigSocket from "./useConfigSocket.js";

const AUTH_STORAGE_KEY = "sakuratg-config-session";

class ApiError extends Error {
  constructor(message, response, payload) {
    super(message);
    this.status = response?.status || 0;
    this.code = payload?.code;
    this.errors = payload?.errors || [];
  }
}

function readStoredSession() {
  try {
    const value = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
    if (
      !value?.token ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now()
    ) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      return null;
    }
    return value;
  } catch {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return null;
  }
}

function storeSession(token, expiresAt) {
  if (!token || !expiresAt) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }
  localStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ token, expiresAt })
  );
}

function createRequestId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export default function useConfig(notify) {
  const notifyRef = useRef(notify);
  const tokenRef = useRef("");
  const ownRequestIdsRef = useRef(new Set());
  const [phase, setPhase] = useState("boot");
  const [fatalError, setFatalError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [sessionToken, setSessionToken] = useState("");
  const [schema, setSchema] = useState(null);
  const [original, setOriginal] = useState(null);
  const [draft, setDraft] = useState(null);
  const [revision, setRevision] = useState("");
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);
  const [restartPaths, setRestartPaths] = useState([]);
  const [remoteChange, setRemoteChange] = useState(null);

  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  const clearSession = useCallback(() => {
    tokenRef.current = "";
    setSessionToken("");
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }, []);

  const request = useCallback(
    async (path, { json, headers: extraHeaders, ...options } = {}) => {
      const headers = {
        Accept: "application/json",
        ...(extraHeaders || {}),
      };
      if (tokenRef.current) {
        headers.Authorization = `Bearer ${tokenRef.current}`;
      }
      if (json !== undefined) headers["Content-Type"] = "application/json";

      let response;
      try {
        response = await fetch(path, {
          ...options,
          headers,
          body: json === undefined ? options.body : JSON.stringify(json),
          cache: "no-store",
        });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        throw new ApiError("无法连接配置服务");
      }

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) {
        if (
          response.status === 401 &&
          !["/api/login", "/api/session"].includes(path)
        ) {
          clearSession();
          setOriginal(null);
          setDraft(null);
          setPhase("login");
        }
        throw new ApiError(
          payload.error || `请求失败 (${response.status})`,
          response,
          payload
        );
      }
      return payload;
    },
    [clearSession]
  );

  const refreshStatus = useCallback(async () => {
    try {
      const payload = await request("/api/status");
      setStatus(payload.data);
      return payload.data;
    } catch {
      setStatus(null);
      return null;
    }
  }, [request]);

  const loadConfiguration = useCallback(
    async ({ quiet = false } = {}) => {
      setLoading(true);
      try {
        const [schemaPayload, configPayload] = await Promise.all([
          request("/api/schema"),
          request("/api/config"),
        ]);
        setSchema(schemaPayload.data);
        setOriginal(clone(configPayload.data));
        setDraft(clone(configPayload.data));
        setRevision(configPayload.revision || "");
        setErrors([]);
        setRemoteChange(null);
        await refreshStatus();
        setFatalError("");
        setPhase("ready");
        if (!quiet) notifyRef.current?.("已重新读取 config.yaml", "success");
        return true;
      } finally {
        setLoading(false);
      }
    },
    [refreshStatus, request]
  );

  const initialize = useCallback(async () => {
    setPhase("boot");
    setFatalError("");
    const stored = readStoredSession();
    tokenRef.current = stored?.token || "";
    setSessionToken(tokenRef.current);

    try {
      const session = await request("/api/session");
      setAuthRequired(Boolean(session.data.authRequired));
      if (!session.data.authenticated) {
        clearSession();
        setPhase("login");
        return;
      }
      await loadConfiguration({ quiet: true });
    } catch (error) {
      setFatalError(error.message || "配置服务不可用");
      setPhase("error");
    }
  }, [clearSession, loadConfiguration, request]);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (phase !== "ready") return undefined;
    const timer = window.setInterval(() => void refreshStatus(), 30_000);
    return () => window.clearInterval(timer);
  }, [phase, refreshStatus]);

  useEffect(() => {
    const beforeUnload = (event) => {
      if (!original || !draft || JSON.stringify(original) === JSON.stringify(draft)) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [draft, original]);

  const dirty = useMemo(
    () =>
      Boolean(
        original &&
          draft &&
          JSON.stringify(original) !== JSON.stringify(draft)
      ),
    [draft, original]
  );

  const updateValue = useCallback((path, value) => {
    setDraft((current) => withValueAtPath(current, path, value));
    setErrors([]);
  }, []);

  const loadProviderModels = useCallback(
    async (provider, { signal } = {}) => {
      const payload = await request("/api/ai/models", {
        method: "POST",
        json: { provider },
        signal,
      });
      return Array.isArray(payload.data?.models) ? payload.data.models : [];
    },
    [request]
  );

  const login = useCallback(
    async (password) => {
      setLoading(true);
      try {
        const payload = await request("/api/login", {
          method: "POST",
          json: { password },
        });
        tokenRef.current = payload.data.token || "";
        setSessionToken(tokenRef.current);
        setAuthRequired(Boolean(payload.data.authRequired));
        storeSession(tokenRef.current, payload.data.expiresAt);
        await loadConfiguration({ quiet: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message || "登录失败" };
      } finally {
        setLoading(false);
      }
    },
    [loadConfiguration, request]
  );

  const logout = useCallback(async () => {
    try {
      await request("/api/logout", { method: "POST" });
    } catch {
      // 即使服务端不可用，也立即清除浏览器中的会话。
    }
    clearSession();
    setOriginal(null);
    setDraft(null);
    setPhase("login");
  }, [clearSession, request]);

  const reload = useCallback(async () => {
    if (
      dirty &&
      !window.confirm("重新载入会放弃尚未保存的改动，是否继续？")
    ) {
      return false;
    }
    try {
      await loadConfiguration();
      setRestartPaths([]);
      setRemoteChange(null);
      return true;
    } catch (error) {
      notifyRef.current?.(error.message || "载入失败", "error");
      return false;
    }
  }, [dirty, loadConfiguration]);

  const save = useCallback(async () => {
    if (!dirty || saving || !draft) return { ok: false };
    setSaving(true);
    const passwordBefore = original?.web?.password;
    const passwordDraft = draft?.web?.password;

    try {
      const requestId = createRequestId();
      ownRequestIdsRef.current.add(requestId);
      window.setTimeout(
        () => ownRequestIdsRef.current.delete(requestId),
        15_000
      );
      const payload = await request("/api/config", {
        method: "POST",
        json: { data: draft, revision, requestId },
      });
      setOriginal(clone(payload.data));
      setDraft(clone(payload.data));
      setRevision(payload.revision || "");
      setErrors([]);
      setRestartPaths(payload.restartRequired || []);
      setRemoteChange(null);
      notifyRef.current?.("配置已校验并保存", "success");

      if (passwordBefore !== passwordDraft) {
        const session = await request("/api/session");
        setAuthRequired(Boolean(session.data.authRequired));
        if (!session.data.authenticated) {
          clearSession();
          setOriginal(null);
          setDraft(null);
          setPhase("login");
          return {
            ok: true,
            reloginMessage: "面板密码已更新，请使用新密码登录",
          };
        }
      }
      return { ok: true };
    } catch (error) {
      if (error.status === 422) {
        setErrors(error.errors || []);
        notifyRef.current?.("配置未通过校验，请检查标出的字段", "error");
        return { ok: false, errors: error.errors || [] };
      }
      if (error.code === "REVISION_CONFLICT") {
        notifyRef.current?.(error.message, "warning");
        if (
          window.confirm(
            "配置文件已被其他来源修改。现在重新载入会放弃当前草稿，是否继续？"
          )
        ) {
          await loadConfiguration({ quiet: true });
        }
        return { ok: false, conflict: true };
      }
      notifyRef.current?.(error.message || "保存失败", "error");
      return { ok: false };
    } finally {
      setSaving(false);
    }
  }, [
    clearSession,
    dirty,
    draft,
    loadConfiguration,
    original,
    request,
    revision,
    saving,
  ]);

  const handleSocketMessage = useCallback(
    (message) => {
      if (!["ready", "config_changed"].includes(message?.type)) return;
      if (
        message.requestId &&
        ownRequestIdsRef.current.has(message.requestId)
      ) {
        ownRequestIdsRef.current.delete(message.requestId);
        return;
      }
      if (!message.revision || message.revision === revision) return;

      if (dirty) {
        setRemoteChange(message);
        notifyRef.current?.(
          "配置已在其他位置修改，请重新载入后继续编辑",
          "warning"
        );
        return;
      }

      void loadConfiguration({ quiet: true })
        .then(() =>
          notifyRef.current?.("检测到配置变更，页面已自动同步", "info")
        )
        .catch((error) =>
          notifyRef.current?.(error.message || "同步配置失败", "error")
        );
    },
    [dirty, loadConfiguration, revision]
  );

  const handleSocketUnauthorized = useCallback(() => {
    clearSession();
    setOriginal(null);
    setDraft(null);
    setPhase("login");
  }, [clearSession]);

  const socketConnected = useConfigSocket({
    enabled: phase === "ready",
    token: sessionToken,
    onMessage: handleSocketMessage,
    onUnauthorized: handleSocketUnauthorized,
  });

  return {
    authRequired,
    clearRestart: () => setRestartPaths([]),
    dirty,
    draft,
    errors,
    fatalError,
    initialize,
    loading,
    loadProviderModels,
    login,
    logout,
    phase,
    reload,
    restartPaths,
    revision,
    remoteChange,
    save,
    saving,
    schema,
    status,
    socketConnected,
    updateValue,
  };
}
