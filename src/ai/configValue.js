const ENV_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ENV_INTERPOLATION_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ENV_PREFIX_PATTERN = /^env:([A-Za-z_][A-Za-z0-9_]*)$/i;

/**
 * 配置中的敏感值可写成 ${ENV_NAME} 或 env:ENV_NAME。
 * 普通字符串保持原样，便于兼容 Sakura 原有 YAML。
 */
export function resolveConfigValue(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  const envName = ENV_PATTERN.exec(text)?.[1] || ENV_PREFIX_PATTERN.exec(text)?.[1];
  if (envName) return process.env[envName] || "";
  return text.replace(
    ENV_INTERPOLATION_PATTERN,
    (_match, name) => process.env[name] || ""
  );
}

export function resolveStringRecord(record = {}) {
  return Object.fromEntries(
    Object.entries(record || {}).map(([key, value]) => [
      key,
      String(resolveConfigValue(value) ?? ""),
    ])
  );
}
