export const internalRunCallbackKinds = [
  "agent",
  "agentphone",
  "agentphone:chat",
  "chat",
  "github:chat",
  "morning-brief:email",
  "slack:chat",
  "feishu:chat",
  "teams:chat",
  "telegram:chat",
  "feishu:org",
  "telegram",
  "workflow-automation:cron",
  "workflow-automation:loop",
] as const;

export type InternalRunCallbackKind = (typeof internalRunCallbackKinds)[number];

export type InternalRunCallbackStatus = "completed" | "failed" | "progress";

export type InternalRunCallbackDispatchResult =
  | { readonly success: true; readonly skipped?: true }
  | { readonly success: false; readonly error: string };

export interface InternalRunCallbackEnvelope {
  readonly callbackId?: string;
  readonly runId: string;
  readonly status: InternalRunCallbackStatus;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly payload: unknown;
}

interface InternalRunCallbackRecord {
  readonly internalKind: string | null;
}

function isInternalRunCallbackKind(
  value: string | null,
): value is InternalRunCallbackKind {
  switch (value) {
    case "agent":
    case "agentphone":
    case "agentphone:chat":
    case "chat":
    case "github:chat":
    case "morning-brief:email":
    case "slack:chat":
    case "feishu:chat":
    case "teams:chat":
    case "telegram:chat":
    case "feishu:org":
    case "telegram":
    case "workflow-automation:cron":
    case "workflow-automation:loop": {
      return true;
    }
    default: {
      return false;
    }
  }
}

export function internalRunCallbackKindForRecord(
  callback: InternalRunCallbackRecord,
): InternalRunCallbackKind | null {
  return isInternalRunCallbackKind(callback.internalKind)
    ? callback.internalKind
    : null;
}
