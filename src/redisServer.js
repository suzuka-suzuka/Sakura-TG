import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { logger } from "./logger.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const PORT_PROBE_TIMEOUT_MS = 300;
const PORT_PROBE_INTERVAL_MS = 100;

function stripWrappingQuotes(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

export function isLoopbackRedisHost(host) {
  const normalized = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");

  const mappedIpv4 = normalized.match(/^::ffff:(.+)$/)?.[1];

  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    (net.isIP(normalized) === 4 && normalized.startsWith("127.")) ||
    (net.isIP(mappedIpv4 || "") === 4 && mappedIpv4.startsWith("127."))
  );
}

export function resolveRedisServerExecutable(
  configuredPath,
  {
    cwd = process.cwd(),
    platform = process.platform,
    statSync = fs.statSync,
  } = {}
) {
  const input = stripWrappingQuotes(configuredPath);
  if (!input) return "";

  const resolved = path.resolve(cwd, input);
  let stat;
  try {
    stat = statSync(resolved);
  } catch (error) {
    throw new Error(`Redis 启动路径不存在: ${resolved}`, { cause: error });
  }

  if (stat.isDirectory()) {
    const executable = path.join(
      resolved,
      platform === "win32" ? "redis-server.exe" : "redis-server"
    );
    try {
      if (!statSync(executable).isFile()) throw new Error("不是文件");
    } catch (error) {
      throw new Error(`Redis 目录中未找到服务程序: ${executable}`, {
        cause: error,
      });
    }
    return executable;
  }

  if (!stat.isFile()) {
    throw new Error(`Redis 启动路径不是文件或目录: ${resolved}`);
  }
  return resolved;
}

export function buildRedisServerArgs(config) {
  const args = ["--port", String(config.port)];
  if (config.password) {
    args.push("--requirepass", String(config.password));
  }
  return args;
}

export function isRedisPortOpen(
  host,
  port,
  { timeoutMs = PORT_PROBE_TIMEOUT_MS } = {}
) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function childExitDescription(child) {
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return `退出码 ${child.exitCode}`;
  }
  if (child.signalCode) return `信号 ${child.signalCode}`;
  return "未知原因";
}

async function waitForRedisReady(
  config,
  child,
  {
    probePort = isRedisPortOpen,
    sleep = delay,
    now = Date.now,
    timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  } = {}
) {
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    if (await probePort(config.host, config.port)) return;

    if (
      (child.exitCode !== null && child.exitCode !== undefined) ||
      child.signalCode
    ) {
      throw new Error(
        `Redis 进程启动后立即退出（${childExitDescription(child)}）`
      );
    }
    await sleep(PORT_PROBE_INTERVAL_MS);
  }

  throw new Error(
    `等待 Redis 就绪超时（${config.host}:${config.port}，${timeoutMs}ms）`
  );
}

/**
 * 配置了 execPath 时，在连接 Redis 前确保本机端口已经有服务监听。
 * 启动出的 Redis 使用独立进程运行，SakuraTG 退出时不会关闭它，因为该实例可能与 Sakura 共用。
 */
export async function ensureRedisServer(
  config,
  {
    resolveExecutable = resolveRedisServerExecutable,
    probePort = isRedisPortOpen,
    spawnProcess = spawn,
    sleep = delay,
    now = Date.now,
    timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    log = logger,
  } = {}
) {
  if (!String(config.execPath || "").trim()) {
    return { started: false, reason: "not-configured" };
  }

  if (!isLoopbackRedisHost(config.host)) {
    log.warn(
      `[Redis] 已配置本地启动路径，但 ${config.host} 不是本机地址，已跳过自动启动`
    );
    return { started: false, reason: "remote-host" };
  }

  if (await probePort(config.host, config.port)) {
    log.info(
      `[Redis] ${config.host}:${config.port} 已在监听，无需重复启动本地 Redis`
    );
    return { started: false, reason: "already-listening" };
  }

  const executable = resolveExecutable(config.execPath);
  log.info(`[Redis] 正在启动本地 Redis: ${executable}`);

  let child;
  try {
    child = spawnProcess(executable, buildRedisServerArgs(config), {
      cwd: path.dirname(executable),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await waitForSpawn(child);
  } catch (error) {
    throw new Error(`无法启动本地 Redis: ${error.message}`, { cause: error });
  }

  child.unref();
  try {
    await waitForRedisReady(config, child, {
      probePort,
      sleep,
      now,
      timeoutMs,
    });
  } catch (error) {
    if (child.exitCode === null && !child.signalCode) {
      try {
        child.kill();
      } catch {
        // 进程可能刚好已经退出，保留原始启动错误即可。
      }
    }
    throw error;
  }

  log.info(`[Redis] 本地 Redis 已就绪: ${config.host}:${config.port}`);
  return { started: true, pid: child.pid, executable };
}
