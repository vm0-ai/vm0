export const internalRunCallbackKinds = [
  "agent",
  "agentphone",
  "chat",
  "github:issues",
  "slack:org",
  "teams:org",
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
    case "chat":
    case "github:issues":
    case "slack:org":
    case "teams:org":
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
  if (isInternalRunCallbackKind(callback.internalKind)) {
    return callback.internalKind;
  }

  // Compatibility for callback rows written before the workflow automation
  // rename. Remove these aliases after the one-release-cycle drain in #21408.
  switch (callback.internalKind) {
    case "workflow-trigger:cron": {
      return "workflow-automation:cron";
    }
    case "workflow-trigger:loop": {
      return "workflow-automation:loop";
    }
    default: {
      return null;
    }
  }
}
