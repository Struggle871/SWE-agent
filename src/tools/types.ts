import type { AgentContext, JsonSchema, ToolResult } from "../types.js";

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** 只读工具可与其它只读工具并行执行（对齐 Claude Code isConcurrencySafe） */
  isReadOnly?: boolean;
  execute(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult>;
}
