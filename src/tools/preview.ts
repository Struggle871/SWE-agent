export type ToolDecision = "allow" | "ask" | "deny";
export type ToolRisk = "read" | "write" | "execute" | "network" | "destructive";

export interface ToolExecutionPreview {
  callId: string;
  toolName: string;
  summary: string;
  risk: ToolRisk;
  cwd: string;
  affectedPaths: string[];
  command?: string;
  diff?: string;
  reasons: string[];
}

export interface ToolPreflightResult {
  decision: ToolDecision;
  preview: ToolExecutionPreview;
  normalizedInput: Record<string, unknown>;
  permissionFingerprint: string;
  fileHashes: Record<string, string | null>;
}
