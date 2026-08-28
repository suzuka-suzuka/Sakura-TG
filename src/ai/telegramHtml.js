const TOKEN_START = "\uE000";
const TOKEN_END = "\uE001";
const TOKEN_PATTERN = /\uE000(\d+)\uE001/g;
const DEFAULT_MAX_LENGTH = 3900;

export function escapeTelegramHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value) {
  return escapeTelegramHtml(value).replace(/"/g, "&quot;");
}

function supportedLinkUrl(value) {
  const url = String(value || "").trim();
  return /^(?:https?:\/\/|tg:\/\/|mailto:)/i.test(url) ? url : "";
}

function plainInlineText(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/(\*\*\*|___|\*\*|__|~~|\|\||[*_~])/g, "");
}

function renderInline(source) {
  const tokens = [];
  const store = (value) => {
    const token = `${TOKEN_START}${tokens.length}${TOKEN_END}`;
    tokens.push(value);
    return token;
  };
  let text = String(source || "");

  // Markdown 反斜杠转义表示“按字面显示”，先保护再做格式解析。
  text = text.replace(
    /\\([\\_*[\]()~`>#+\-=|{}.!])/g,
    (_match, char) => store(escapeTelegramHtml(char))
  );

  text = text.replace(/(`+)([\s\S]*?)\1/g, (_match, _ticks, code) =>
    store(`<code>${escapeTelegramHtml(code)}</code>`)
  );

  text = text.replace(
    /!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+["'][^"']*["'])?\)/g,
    (_match, alt, rawUrl) => {
      const url = supportedLinkUrl(rawUrl);
      const label = escapeTelegramHtml(
        `图片${alt.trim() ? `：${plainInlineText(alt)}` : ""}`
      );
      return url
        ? store(`<a href="${escapeHtmlAttribute(url)}">${label}</a>`)
        : store(label);
    }
  );

  text = text.replace(
    /\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+["'][^"']*["'])?\)/g,
    (_match, label, rawUrl) => {
      const url = supportedLinkUrl(rawUrl);
      return url
        ? store(
            `<a href="${escapeHtmlAttribute(url)}">${renderInline(label)}</a>`
          )
        : store(
            `${renderInline(label)} ${escapeTelegramHtml(`(${rawUrl})`)}`
          );
    }
  );

  text = text.replace(
    /<(https?:\/\/[^>\s]+)>/gi,
    (_match, url) =>
      store(
        `<a href="${escapeHtmlAttribute(url)}">${escapeTelegramHtml(
          url
        )}</a>`
      )
  );

  text = text.replace(
    /(?:\*\*\*|___)(.+?)(?:\*\*\*|___)/g,
    (_match, content) => store(`<b><i>${renderInline(content)}</i></b>`)
  );
  text = text.replace(
    /\*\*(.+?)\*\*/g,
    (_match, content) => store(`<b>${renderInline(content)}</b>`)
  );
  text = text.replace(
    /__(.+?)__/g,
    (_match, content) => store(`<b>${renderInline(content)}</b>`)
  );
  text = text.replace(
    /~~(.+?)~~/g,
    (_match, content) => store(`<s>${renderInline(content)}</s>`)
  );
  text = text.replace(
    /\|\|(.+?)\|\|/g,
    (_match, content) =>
      store(`<tg-spoiler>${renderInline(content)}</tg-spoiler>`)
  );
  text = text.replace(
    /(?<!\*)\*([^*\n]+?)\*(?!\*)/g,
    (_match, content) => store(`<i>${renderInline(content)}</i>`)
  );
  text = text.replace(
    /(?<![\w_])_([^_\n]+?)_(?![\w_])/g,
    (_match, content) => store(`<i>${renderInline(content)}</i>`)
  );

  text = escapeTelegramHtml(text);
  return text.replace(
    TOKEN_PATTERN,
    (_match, index) => tokens[Number(index)] ?? ""
  );
}

function renderCodeFence(language, code) {
  const safeLanguage = String(language || "").replace(/[^\w+-]/g, "");
  const className = safeLanguage
    ? ` class="language-${escapeHtmlAttribute(safeLanguage)}"`
    : "";
  return `<pre><code${className}>${escapeTelegramHtml(code)}</code></pre>`;
}

function renderNormalLine(line) {
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
  if (heading) {
    return `<b>${escapeTelegramHtml(plainInlineText(heading[1]))}</b>`;
  }

  if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    return "────────";
  }

  const task = /^(\s*)[-+*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
  if (task) {
    return `${task[1]}${task[2].trim() ? "☑" : "☐"} ${renderInline(
      task[3]
    )}`;
  }

  const unordered = /^(\s*)[-+*]\s+(.*)$/.exec(line);
  if (unordered) {
    return `${unordered[1]}• ${renderInline(unordered[2])}`;
  }

  const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (ordered) {
    return `${ordered[1]}${ordered[2]}. ${renderInline(ordered[3])}`;
  }

  const quote = /^(\s*)>\s?(.*)$/.exec(line);
  if (quote) {
    return `${quote[1]}<blockquote>${renderInline(
      quote[2]
    )}</blockquote>`;
  }

  return renderInline(line);
}

export function renderTelegramHtml(value) {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let fence = null;

  for (const line of lines) {
    if (!fence) {
      const opening = /^\s{0,3}(```|~~~)\s*([^\s`]*)\s*$/.exec(line);
      if (opening) {
        fence = {
          marker: opening[1],
          language: opening[2] || "",
          lines: [],
        };
        continue;
      }
      output.push(renderNormalLine(line));
      continue;
    }

    if (new RegExp(`^\\s{0,3}${fence.marker}\\s*$`).test(line)) {
      output.push(renderCodeFence(fence.language, fence.lines.join("\n")));
      fence = null;
    } else {
      fence.lines.push(line);
    }
  }

  if (fence) {
    output.push(renderCodeFence(fence.language, fence.lines.join("\n")));
  }
  return output.join("\n");
}

function splitSource(value) {
  const source = String(value || "");
  const middle = Math.floor(source.length / 2);
  const candidates = [
    source.lastIndexOf("\n\n", middle),
    source.lastIndexOf("\n", middle),
    source.lastIndexOf(" ", middle),
  ];
  let cut = candidates.find((index) => index >= source.length * 0.25);
  if (!Number.isInteger(cut) || cut <= 0) cut = middle;

  const chunks = [
    source.slice(0, cut).trimEnd(),
    source.slice(cut).trimStart(),
  ].filter(Boolean);
  return chunks.length > 1
    ? chunks
    : [source.slice(0, middle), source.slice(middle)].filter(Boolean);
}

export function renderTelegramHtmlChunks(
  value,
  maxLength = DEFAULT_MAX_LENGTH
) {
  const source = String(value ?? "");
  if (!source) return [];

  const pending = [source];
  const chunks = [];
  while (pending.length > 0) {
    const raw = pending.shift();
    const html = renderTelegramHtml(raw);
    if (html.length <= maxLength || raw.length <= 1) {
      chunks.push({ raw, html });
      continue;
    }
    pending.unshift(...splitSource(raw));
  }
  return chunks;
}

export function isTelegramHtmlParseError(error) {
  const message = String(error?.description || error?.message || error || "");
  return /can't parse entities|can't find end of the entity|unsupported start tag|entity.*(?:invalid|parse)/i.test(
    message
  );
}

export { DEFAULT_MAX_LENGTH };
