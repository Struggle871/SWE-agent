// 极简 TOML 解析器：支持注释、扁平的 key = value、[section] 嵌套。
// 仅覆盖配置所需子集（字符串/数字/布尔），不实现数组、多行字符串、日期等。

export type TomlValue = string | number | boolean | Record<string, unknown>;

export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = stripComment(line).trim();
    if (!trimmed) continue;

    // [section]
    const section = trimmed.match(/^\[([^\]]+)\]\s*$/);
    if (section) {
      const key = section[1].trim();
      current = (root[key] as Record<string, unknown>) ?? {};
      root[key] = current;
      continue;
    }

    // key = value
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    if (!key) continue;

    current[key] = parseValue(rawValue);
  }

  return root;
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inString = !inString;
    else if (ch === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function parseValue(raw: string): TomlValue {
  // 字符串
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  // 布尔
  if (raw === "true") return true;
  if (raw === "false") return false;
  // 数字
  const num = Number(raw);
  if (raw !== "" && !Number.isNaN(num)) return num;
  // 兜底：裸字符串
  return raw;
}
