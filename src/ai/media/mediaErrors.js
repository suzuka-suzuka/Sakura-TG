const PROVIDER_NAMES = {
  grok: "Grok",
  gemini: "Gemini",
  openai: "OpenAI",
  vertex: "Vertex",
  novelai: "NovelAI",
};

export function redactMediaErrorMessage(message) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----/gis,
      "[PRIVATE KEY REDACTED]"
    )
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer ***")
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|private[_-]?key)["']?\s*[:=]\s*["']?)[^,"'\s;}]+/gi,
      "$1***"
    )
    .replace(/([?&](?:key|api[_-]?key|token)=)[^&\s]+/gi, "$1***")
    .trim();
}

export function tagMediaError(error, provider, kind) {
  const tagged =
    error instanceof Error
      ? error
      : new Error(error?.message || String(error || "媒体生成失败"));
  tagged.mediaProvider ||= provider;
  tagged.mediaKind ||= kind;
  return tagged;
}

export function formatMediaUserError(error, options = {}) {
  const message = redactMediaErrorMessage(
    error?.message || String(error || "")
  );
  const provider = options.provider || error?.mediaProvider;
  const kind = options.kind || error?.mediaKind || "媒体";
  const name = PROVIDER_NAMES[provider] || "当前渠道";

  if (
    /未配置|未找到名为|需要.*(?:Key|凭据)|请输入提示词|请提供提示词/.test(
      message
    )
  ) {
    return message.slice(0, 300);
  }
  if (
    /NovelAI V5 用量|Vibe Transfer|Anlas|最多支持 \d+ 个角色|无法验证 NovelAI 用量|NovelAI 用量查询/.test(
      message
    )
  ) {
    return message.slice(0, 500);
  }
  if (
    /safety|moderation|content filter|policy|blocked|安全|审核|违规|拦截/i.test(
      message
    )
  ) {
    return `内容触发了 ${name} 的安全审核，请修改后重试。`;
  }
  if (/401|unauthorized|invalid.*key|鉴权|认证失败/i.test(message)) {
    return `${name} 鉴权失败，请检查凭据。`;
  }
  if (/403|forbidden|permission|权限不足/i.test(message)) {
    return `${name} 权限不足，请检查项目授权。`;
  }
  if (/429|rate.?limit|quota|配额|限流/i.test(message)) {
    return `${name} 当前额度或请求频率受限，请稍后重试。`;
  }
  if (/timeout|timed out|超时/i.test(message)) {
    return `${name} 等待超时，任务可能仍在排队。`;
  }
  if (/ECONN|ENOTFOUND|fetch failed|connection/i.test(message)) {
    return `${name} 暂时无法连接，请检查渠道地址后重试。`;
  }
  if (/没有返回|did not return/i.test(message)) {
    return `${name} 没有返回${kind === "video" ? "视频" : "图片"}结果。`;
  }
  return `${name} 请求失败，详细原因已记录到日志。`;
}
