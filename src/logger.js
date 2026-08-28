import chalk from "chalk";

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

const LEVEL_STYLE = {
  trace: chalk.gray,
  debug: chalk.blue,
  info: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
};

let currentLevel = LEVELS.info;

export function setLogLevel(level) {
  if (LEVELS[level] !== undefined) currentLevel = LEVELS[level];
}

function stamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function emit(level, args) {
  if (LEVELS[level] < currentLevel) return;
  const tag = LEVEL_STYLE[level](`[${level.toUpperCase()}]`);
  const out = level === "error" || level === "warn" ? console.error : console.log;
  out(`${chalk.gray(stamp())} ${tag}`, ...args);
}

/**
 * 方法名与 Sakura 的 logger 保持一致（info/warn/error/debug/trace + 颜色助手），
 * 从 Sakura 搬过来的代码直接调用即可，不用改写法。
 */
export const logger = {
  trace: (...args) => emit("trace", args),
  debug: (...args) => emit("debug", args),
  info: (...args) => emit("info", args),
  warn: (...args) => emit("warn", args),
  error: (...args) => emit("error", args),

  red: chalk.red,
  green: chalk.green,
  yellow: chalk.yellow,
  blue: chalk.blue,
  cyan: chalk.cyan,
  magenta: chalk.magenta,
  gray: chalk.gray,
};
