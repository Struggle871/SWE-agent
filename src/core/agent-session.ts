import path from "node:path";
import type { AgentContext, AgentRunResult } from "../types.js";
import type { AgentEvent } from "./events.js";
import { SessionCoordinator, type SessionCoordinatorOptions } from "./session-coordinator.js";
import { asSessionId, type SessionId } from "../protocol/ids.js";
import { TranscriptStore } from "../persistence/transcript-store.js";
import type { CompactionResult } from "./context/compaction-types.js";
import type { ReconstructedSession } from "../persistence/reconstruction.js";

export interface AgentSessionOptions { transcriptRoot?: string }

/** Compatibility facade. M4 lifecycle ownership lives in SessionCoordinator. */
export class AgentSession {
  private readonly coordinator: SessionCoordinator;

  constructor(ctx: AgentContext, onEvent?: (event: AgentEvent) => void, options: AgentSessionOptions & SessionCoordinatorOptions = {}) {
    this.coordinator = new SessionCoordinator(ctx, onEvent, options);
  }

  static async resume(
    ctx: AgentContext,
    sessionId: string,
    onEvent?: (event: AgentEvent) => void,
    options: AgentSessionOptions = {},
  ): Promise<AgentSession> {
    const id = asSessionId(sessionId);
    const transcriptRoot = options.transcriptRoot ?? defaultTranscriptRoot(ctx);
    const restored = await new TranscriptStore(transcriptRoot).resume(id);
    return new AgentSession(ctx, onEvent, {
      transcriptRoot,
      sessionId: id,
      writer: restored.writer,
      restoredState: restored.state,
    });
  }

  static async fork(
    ctx: AgentContext,
    parentSessionId: string,
    forkOptions: { atOrdinal?: number; reason?: string; newSessionId?: SessionId } = {},
    onEvent?: (event: AgentEvent) => void,
    options: AgentSessionOptions = {},
  ): Promise<AgentSession> {
    const transcriptRoot = options.transcriptRoot ?? defaultTranscriptRoot(ctx);
    const forked = await new TranscriptStore(transcriptRoot).fork(asSessionId(parentSessionId), forkOptions);
    return new AgentSession(ctx, onEvent, {
      transcriptRoot,
      sessionId: forked.state.sessionId,
      writer: forked.writer,
      restoredState: forked.state,
    });
  }

  run(userRequest: string, options?: { signal?: AbortSignal }): Promise<AgentRunResult> {
    return this.coordinator.run(userRequest, options?.signal);
  }

  compact(options: { prompt?: string; signal?: AbortSignal } = {}): Promise<CompactionResult> {
    return this.coordinator.compact(options.prompt, options.signal);
  }

  rollback(throughOrdinal: number, reason?: string): Promise<ReconstructedSession> {
    return this.coordinator.rollback(throughOrdinal, reason);
  }

  interrupt(reason?: string): void {
    this.coordinator.interrupt(reason);
  }

  steer(text: string): void {
    this.coordinator.steer(text);
  }

  shutdown(reason?: string): void {
    this.coordinator.shutdown(reason);
  }

  close(reason?: string): Promise<void> { return this.coordinator.close(reason); }
  flush(): Promise<void> { return this.coordinator.flush(); }

  get sessionState() {
    return this.coordinator.sessionState;
  }

  get hasActiveTurn(): boolean {
    return this.coordinator.hasActiveTurn;
  }

  get sessionId(): SessionId { return this.coordinator.id; }
  get transcriptPath(): string { return this.coordinator.transcriptPath; }
  get recovery() { return this.coordinator.recovery; }
}

function defaultTranscriptRoot(ctx: AgentContext): string {
  return path.join(ctx.workspaceRoot, ".swe-agent", "sessions");
}
