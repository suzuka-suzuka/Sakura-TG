export const SECRET_MASK = "__SAKURATG_SECRET_UNCHANGED__";

function pathEquals(path, expected) {
  return (
    path.length === expected.length &&
    expected.every(
      (part, index) => part === "*" || String(path[index]) === String(part)
    )
  );
}

export function isSecretConfigPath(path) {
  const patterns = [
    ["telegram", "token"],
    ["redis", "password"],
    ["web", "password"],
    ["ai", "providers", "*", "credentials", "*", "apiKey"],
    ["ai", "novelAI", "api"],
  ];

  return patterns.some((pattern) => pathEquals(path, pattern));
}

function mapTree(value, visitor, path = []) {
  const visited = visitor(value, path);
  if (visited !== value) return visited;

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      mapTree(item, visitor, [...path, index])
    );
  }

  if (value && typeof value === "object") {
    const result = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      result[key] = mapTree(item, visitor, [...path, key]);
    }
    return result;
  }

  return value;
}

/**
 * 返回适合发送到浏览器的配置副本。非空密钥只暴露统一占位符，
 * 浏览器无法据此恢复原值。
 */
export function maskConfigSecrets(config) {
  return mapTree(config, (value, path) => {
    if (
      isSecretConfigPath(path) &&
      typeof value === "string" &&
      value.length > 0
    ) {
      return SECRET_MASK;
    }
    return value;
  });
}

/**
 * 保存前将密钥占位符替换回当前配置中的原值。空字符串表示用户明确清空，
 * 不会被误判成“保持不变”。
 */
export function restoreConfigSecrets(incoming, current) {
  const readCurrent = (path) =>
    path.reduce((value, key) => value?.[key], current);

  return mapTree(incoming, (value, path) => {
    if (isSecretConfigPath(path) && value === SECRET_MASK) {
      return readCurrent(path) ?? "";
    }
    return value;
  });
}
