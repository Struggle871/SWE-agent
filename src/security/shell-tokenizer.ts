export type ShellDialect = "bash" | "cmd" | "powershell";
export type ShellTokenKind = "word" | "operator" | "redirect" | "lparen" | "rparen";
export type ShellOperator = ";" | "&&" | "||" | "|" | "&";

export interface ShellToken {
  kind: ShellTokenKind;
  value: string;
  start: number;
  end: number;
  quoted: boolean;
  dynamic: boolean;
}

export class ShellTokenizationError extends Error {
  constructor(message: string, public readonly position: number) {
    super(`${message}（位置 ${position}）`);
    this.name = "ShellTokenizationError";
  }
}

const OPERATORS = ["&&", "||", ">>", "2>>", "2>", ";", "|", "&", ">", "<", "(", ")"];

export function tokenizeShell(command: string, dialect: ShellDialect = defaultShellDialect()): ShellToken[] {
  const tokens: ShellToken[] = [];
  let value = "";
  let start = -1;
  let quoted = false;
  let dynamic = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = (end: number) => {
    if (start === -1) return;
    tokens.push({ kind: "word", value, start, end, quoted, dynamic });
    value = "";
    start = -1;
    quoted = false;
    dynamic = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      if (start === -1) start = i - 1;
      value += ch;
      escaped = false;
      quoted = true;
      continue;
    }
    if (!quote && ((dialect === "bash" && ch === "\\") || (dialect !== "bash" && (ch === "^" || ch === "`")))) {
      if (start === -1) start = i;
      escaped = true;
      quoted = true;
      continue;
    }
    if (quote) {
      if (ch === quote) { quote = null; quoted = true; continue; }
      if (dialect === "bash" && quote === '"' && ch === "$" && command[i + 1] === "(") dynamic = true;
      value += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (start === -1) start = i;
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      if (start === -1) start = i;
      const end = findCommandSubstitutionEnd(command, i + 1);
      value += command.slice(i, end + 1);
      dynamic = true;
      i = end;
      continue;
    }
    if (ch === "$" && /[A-Za-z_{]/.test(command[i + 1] ?? "")) {
      if (start === -1) start = i;
      value += ch;
      dynamic = true;
      continue;
    }
    if (dialect === "cmd" && ch === "%") {
      const end = command.indexOf("%", i + 1);
      if (end > i + 1) {
        if (start === -1) start = i;
        value += command.slice(i, end + 1);
        dynamic = true;
        i = end;
        continue;
      }
    }
    if (ch === "`" && dialect !== "cmd") {
      if (start === -1) start = i;
      const end = findBacktickEnd(command, i + 1);
      value += command.slice(i, end + 1);
      dynamic = true;
      i = end;
      continue;
    }
    if (ch === "*" || ch === "?") dynamic = true;
    if (/\s/.test(ch)) { flush(i); continue; }
    const operator = OPERATORS.find((candidate) => command.startsWith(candidate, i));
    if (operator) {
      flush(i);
      const kind: ShellTokenKind = operator === "(" ? "lparen" : operator === ")" ? "rparen" : operator === ";" || operator === "&&" || operator === "||" || operator === "|" || operator === "&" ? "operator" : "redirect";
      tokens.push({ kind, value: operator, start: i, end: i + operator.length, quoted: false, dynamic: false });
      i += operator.length - 1;
      continue;
    }
    if (start === -1) start = i;
    value += ch;
  }
  if (escaped) throw new ShellTokenizationError("转义符后缺少字符", command.length - 1);
  if (quote) throw new ShellTokenizationError("未闭合引号", command.length - 1);
  flush(command.length);
  return tokens;
}

export function defaultShellDialect(): ShellDialect {
  return process.platform === "win32" ? "cmd" : "bash";
}

function findCommandSubstitutionEnd(command: string, openingParen: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openingParen; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) { if (ch === quote && command[i - 1] !== "\\") quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") depth += 1;
    if (ch === ")") { depth -= 1; if (depth === 0) return i; }
  }
  throw new ShellTokenizationError("未闭合命令替换", openingParen - 1);
}

function findBacktickEnd(command: string, start: number): number {
  for (let i = start; i < command.length; i += 1) if (command[i] === "`" && command[i - 1] !== "\\") return i;
  throw new ShellTokenizationError("未闭合命令替换", start - 1);
}
