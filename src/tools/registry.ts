import type { Tool } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  names(): Set<string> {
    return new Set(this.tools.keys());
  }

  /** 工具是否为只读（用于流式执行的并发安全判定） */
  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.isReadOnly ?? false;
  }
}
