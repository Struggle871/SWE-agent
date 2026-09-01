import { defaultShellDialect, tokenizeShell, type ShellDialect, type ShellOperator, type ShellToken } from "./shell-tokenizer.js";
export type { ShellDialect } from "./shell-tokenizer.js";

export interface ShellWord {
  value: string;
  quoted: boolean;
  dynamic: boolean;
  start: number;
  end: number;
}

export interface ShellRedirect {
  operator: string;
  target?: ShellWord;
}

export interface ShellCommand {
  kind: "command";
  argv: ShellWord[];
  redirects: ShellRedirect[];
  dynamic: boolean;
  start: number;
  end: number;
}

export interface ShellGroup {
  kind: "group";
  body: ShellCommandChain;
  start: number;
  end: number;
}

export type ShellCommandNode = ShellCommand | ShellGroup;

export interface ShellCommandChain {
  kind: "chain";
  commands: ShellCommandNode[];
  operators: ShellOperator[];
  tokens: ShellToken[];
  dialect: ShellDialect;
}

export interface ShellParserAdapter {
  readonly dialect: ShellDialect;
  parse(command: string): ShellCommandChain;
}

export class BasicShellParserAdapter implements ShellParserAdapter {
  constructor(public readonly dialect: ShellDialect = defaultShellDialect()) {}

  parse(command: string): ShellCommandChain {
    return parseShell(command, this.dialect);
  }
}

export function shellParserFor(dialect: ShellDialect): ShellParserAdapter {
  return new BasicShellParserAdapter(dialect);
}

export class ShellParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellParseError";
  }
}

export function parseShell(command: string, dialect: ShellDialect = defaultShellDialect()): ShellCommandChain {
  const tokens = tokenizeShell(command, dialect);
  let index = 0;
  const parseChain = (stopAtRParen: boolean): ShellCommandChain => {
    const commands: ShellCommandNode[] = [];
    const operators: ShellOperator[] = [];
    while (index < tokens.length && (!stopAtRParen || tokens[index].kind !== "rparen")) {
      const node = parseNode(stopAtRParen);
      if (node) commands.push(node);
      if (index >= tokens.length || (stopAtRParen && tokens[index].kind === "rparen")) break;
      const token = tokens[index];
      if (token.kind !== "operator") throw new ShellParseError(`命令之间缺少控制操作符: ${token.value}`);
      operators.push(token.value as ShellOperator);
      index += 1;
    }
    return { kind: "chain", commands, operators, tokens, dialect };
  };
  const parseNode = (stopAtRParen: boolean): ShellCommandNode | null => {
    const first = tokens[index];
    if (!first) return null;
    if (first.kind === "lparen") {
      index += 1;
      const body = parseChain(true);
      if (tokens[index]?.kind !== "rparen") throw new ShellParseError("未闭合子 Shell");
      const end = tokens[index].end;
      index += 1;
      return { kind: "group", body, start: first.start, end };
    }
    if (first.kind !== "word") throw new ShellParseError(`命令不能以 ${first.value} 开始`);
    const argv: ShellWord[] = [];
    const redirects: ShellRedirect[] = [];
    let dynamic = false;
    const start = first.start;
    let end = first.end;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.kind === "word") {
        const word = toWord(token);
        argv.push(word);
        dynamic ||= word.dynamic;
        end = token.end;
        index += 1;
        continue;
      }
      if (token.kind === "redirect") {
        index += 1;
        const target = tokens[index]?.kind === "word" ? toWord(tokens[index++]) : undefined;
        redirects.push({ operator: token.value, target });
        dynamic ||= target?.dynamic ?? false;
        end = target?.end ?? token.end;
        continue;
      }
      break;
    }
    return { kind: "command", argv, redirects, dynamic, start, end };
  };
  const result = parseChain(false);
  if (index !== tokens.length) throw new ShellParseError(`无法解析 token: ${tokens[index].value}`);
  if (result.commands.length === 0) throw new ShellParseError("命令为空");
  return result;
}

export const parseShellCommand = parseShell;

function toWord(token: ShellToken): ShellWord {
  return { value: token.value, quoted: token.quoted, dynamic: token.dynamic, start: token.start, end: token.end };
}
