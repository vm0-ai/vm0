/**
 * Persisted callback kinds accepted during the rolling-deploy drain. Producers
 * emit `workflow-automation:*`; legacy `workflow-trigger:*` rows remain readable
 * until every in-flight run from the previous release has completed.
 */
export const internalRunCallbackKinds = [
  "agent",
  "agentphone",
  "chat",
  "github:issues",
  "slack:org",
  "teams:org",
  "telegram",
  "workflow-trigger:cron",
  "workflow-trigger:loop",
  "workflow-automation:cron",
  "workflow-automation:loop",
] as const;

export type InternalRunCallbackKind = (typeof internalRunCallbackKinds)[number];

export type NormalizedInternalRunCallbackKind = Exclude<
  InternalRunCallbackKind,
  "workflow-trigger:cron" | "workflow-trigger:loop"
>;

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

function isNormalizedInternalRunCallbackKind(
  value: string | null,
): value is NormalizedInternalRunCallbackKind {
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
): NormalizedInternalRunCallbackKind | null {
  if (isNormalizedInternalRunCallbackKind(callback.internalKind)) {
    return callback.internalKind;
  }

  // Contract-phase compatibility for rows written before canonical emission.
  // Keep this normalization through the rolling-deploy drain.
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
