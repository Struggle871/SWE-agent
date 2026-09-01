import type { CallId } from "./ids.js";

export type AgentError =
  | { kind: "configuration"; recoverable: false; message: string }
  | { kind: "transport"; recoverable: true; message: string; retryAfterMs?: number }
  | { kind: "protocol"; recoverable: true; message: string; raw: string }
  | { kind: "tool_validation"; recoverable: true; message: string; callId: CallId }
  | { kind: "tool_runtime"; recoverable: true; message: string; callId: CallId }
  | { kind: "permission"; recoverable: true; message: string; callId: CallId }
  | { kind: "cancelled"; recoverable: false; message: string; reason: string };

export function isAgentError(value: unknown): value is AgentError {
  return typeof value === "object" && value !== null && "kind" in value && "recoverable" in value;
}

export function agentErrorMessage(error: AgentError): string {
  return error.message;
}
