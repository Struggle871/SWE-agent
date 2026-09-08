import { randomBytes, randomUUID } from "node:crypto";

type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, "SessionId">;
export type TurnId = Brand<string, "TurnId">;
export type StepId = Brand<string, "StepId">;
export type RequestId = Brand<string, "RequestId">;
export type CallId = Brand<string, "CallId">;
export type CompactionId = Brand<string, "CompactionId">;
export type WindowId = Brand<string, "WindowId">;
export type HistoryOrdinal = Brand<number, "HistoryOrdinal">;

function createId<T extends string>(): T {
  return randomUUID() as T;
}

function asId<T extends string>(value: string, label: string): T {
  if (!value.trim()) throw new Error(`${label} 不能为空`);
  return value as T;
}

export const createSessionId = (): SessionId => createId<SessionId>();
export const createTurnId = (): TurnId => createId<TurnId>();
export const createStepId = (): StepId => createId<StepId>();
export const createRequestId = (): RequestId => createId<RequestId>();
export const createCallId = (): CallId => createId<CallId>();
export const createCompactionId = (): CompactionId => createId<CompactionId>();
export const createWindowId = (): WindowId => createUuidV7() as WindowId;

export const asSessionId = (value: string): SessionId => asId(value, "sessionId");
export const asTurnId = (value: string): TurnId => asId(value, "turnId");
export const asStepId = (value: string): StepId => asId(value, "stepId");
export const asRequestId = (value: string): RequestId => asId(value, "requestId");
export const asCallId = (value: string): CallId => asId(value, "callId");
export const asCompactionId = (value: string): CompactionId => asId(value, "compactionId");
export const asWindowId = (value: string): WindowId => asId(value, "windowId");

export const asHistoryOrdinal = (value: number): HistoryOrdinal => {
  if (!Number.isInteger(value) || value < 0) throw new Error("history ordinal 必须是非负整数");
  return value as HistoryOrdinal;
};

function createUuidV7(): string {
  const bytes = new Uint8Array(randomBytes(16));
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
