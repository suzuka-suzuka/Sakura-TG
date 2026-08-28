import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import {
  buildRedisServerArgs,
  ensureRedisServer,
  isLoopbackRedisHost,
  resolveRedisServerExecutable,
} from "../src/redisServer.js";

test("只把回环地址识别为可自动启动的本机 Redis", () => {
  for (const host of [
    "127.0.0.1",
    "127.8.9.10",
    "localhost",
    "LOCALHOST",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isLoopbackRedisHost(host), true, host);
  }

  for (const host of ["192.168.1.2", "redis.example.com", "0.0.0.0", "127.999.1.1"]) {
    assert.equal(isLoopbackRedisHost(host), false, host);
  }
});

test("Redis 启动路径可以填写程序目录", () => {
  const cwd = path.resolve("virtual-project");
  const directory = path.resolve(cwd, "redis-bin");
  const executable = path.join(directory, "redis-server.exe");
  const fakeDirectoryStat = {
    isDirectory: () => true,
    isFile: () => false,
  };
  const fakeFileStat = {
    isDirectory: () => false,
    isFile: () => true,
  };

  const resolved = resolveRedisServerExecutable("'redis-bin'", {
    cwd,
    platform: "win32",
    statSync(filePath) {
      if (filePath === directory) return fakeDirectoryStat;
      if (filePath === executable) return fakeFileStat;
      throw new Error(`unexpected path: ${filePath}`);
    },
  });

  assert.equal(resolved, executable);
});

test("自动启动参数跟随 Redis 端口和密码", () => {
  assert.deepEqual(
    buildRedisServerArgs({ port: 6380, password: "redis password" }),
    ["--port", "6380", "--requirepass", "redis password"]
  );
  assert.deepEqual(buildRedisServerArgs({ port: 6379, password: "" }), [
    "--port",
    "6379",
  ]);
});

test("未配置路径或端口已监听时不会启动 Redis", async () => {
  let spawned = false;
  const withoutPath = await ensureRedisServer(
    { host: "127.0.0.1", port: 6379, password: "", execPath: "" },
    { spawnProcess: () => (spawned = true) }
  );
  assert.equal(withoutPath.reason, "not-configured");

  const alreadyRunning = await ensureRedisServer(
    {
      host: "127.0.0.1",
      port: 6379,
      password: "",
      execPath: "missing-is-fine-while-running",
    },
    {
      probePort: async () => true,
      spawnProcess: () => (spawned = true),
      log: { info() {}, warn() {} },
    }
  );
  assert.equal(alreadyRunning.reason, "already-listening");
  assert.equal(spawned, false);
});

test("远程 Redis 即使保留本地路径也只跳过自动启动", async () => {
  let warning = "";
  let spawned = false;
  const result = await ensureRedisServer(
    {
      host: "redis.example.com",
      port: 6379,
      password: "",
      execPath: "D:\\Redis\\redis-server.exe",
    },
    {
      spawnProcess: () => (spawned = true),
      log: { info() {}, warn(message) { warning = message; } },
    }
  );

  assert.equal(result.reason, "remote-host");
  assert.equal(spawned, false);
  assert.match(warning, /跳过自动启动/);
});

test("端口未监听时启动 Redis 并等待就绪", async () => {
  const executable = path.join(
    process.cwd(),
    "redis-test-bin",
    process.platform === "win32" ? "redis-server.exe" : "redis-server"
  );
  const child = new EventEmitter();
  child.pid = 2468;
  child.exitCode = null;
  child.signalCode = null;
  let unrefCalled = false;
  child.unref = () => {
    unrefCalled = true;
  };
  child.kill = () => true;

  let probeCount = 0;
  let spawnCall;
  const messages = [];
  const resultPromise = ensureRedisServer(
    {
      host: "127.0.0.1",
      port: 6380,
      password: "not-in-logs",
      execPath: "configured-path",
    },
    {
      resolveExecutable: () => executable,
      probePort: async () => ++probeCount >= 2,
      spawnProcess(command, args, options) {
        spawnCall = { command, args, options };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
      sleep: async () => {},
      log: { info(message) { messages.push(message); }, warn() {} },
    }
  );

  const result = await resultPromise;
  assert.equal(result.started, true);
  assert.equal(result.pid, 2468);
  assert.equal(unrefCalled, true);
  assert.equal(spawnCall.command, executable);
  assert.deepEqual(spawnCall.args, [
    "--port",
    "6380",
    "--requirepass",
    "not-in-logs",
  ]);
  assert.deepEqual(spawnCall.options, {
    cwd: path.dirname(executable),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  assert.equal(messages.join("\n").includes("not-in-logs"), false);
});

test("Redis 启动失败时清理刚拉起的进程", async () => {
  const child = new EventEmitter();
  child.pid = 1357;
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => {};
  let killed = false;
  child.kill = () => {
    killed = true;
    return true;
  };

  let clock = 0;
  await assert.rejects(
    ensureRedisServer(
      {
        host: "127.0.0.1",
        port: 6381,
        password: "",
        execPath: "configured-path",
      },
      {
        resolveExecutable: () => path.resolve("redis-server"),
        probePort: async () => false,
        spawnProcess() {
          queueMicrotask(() => child.emit("spawn"));
          return child;
        },
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        now: () => clock,
        timeoutMs: 200,
        log: { info() {}, warn() {} },
      }
    ),
    /等待 Redis 就绪超时/
  );
  assert.equal(killed, true);
});
