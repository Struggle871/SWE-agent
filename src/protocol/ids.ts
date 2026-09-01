import { randomUUID } from "node:crypto";

type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, "SessionId">;
export type TurnId = Brand<string, "TurnId">;
export type StepId = Brand<string, "StepId">;
export type RequestId = Brand<string, "RequestId">;
export type CallId = Brand<string, "CallId">;
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

export const asSessionId = (value: string): SessionId => asId(value, "sessionId");
export const asTurnId = (value: string): TurnId => asId(value, "turnId");
export const asStepId = (value: string): StepId => asId(value, "stepId");
export const asRequestId = (value: string): RequestId => asId(value, "requestId");
export const asCallId = (value: string): CallId => asId(value, "callId");

export const asHistoryOrdinal = (value: number): HistoryOrdinal => {
  if (!Number.isInteger(value) || value < 0) throw new Error("history ordinal 必须是非负整数");
  return value as HistoryOrdinal;
};
