import { safeUrlParse } from "../utils";

export const internalRunCallbackKinds = [
  "agent",
  "github:issues",
  "slack:org",
  "telegram",
  "trigger:cron",
  "trigger:loop",
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
  readonly url: string | null;
  readonly internalKind: string | null;
}

function isInternalRunCallbackKind(
  value: string | null,
): value is InternalRunCallbackKind {
  switch (value) {
    case "agent":
    case "github:issues":
    case "slack:org":
    case "telegram":
    case "trigger:cron":
    case "trigger:loop": {
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
  return legacyInternalRunCallbackKind(callback.url);
}

function legacyInternalRunCallbackKind(
  url: string | null,
): InternalRunCallbackKind | null {
  if (!url) {
    return null;
  }

  const path = safeUrlParse(url)?.pathname ?? url;
  switch (path) {
    case "/api/internal/callbacks/agent": {
      return "agent";
    }
    case "/api/internal/callbacks/github/issues": {
      return "github:issues";
    }
    case "/api/internal/callbacks/slack/org": {
      return "slack:org";
    }
    case "/api/internal/callbacks/telegram": {
      return "telegram";
    }
    case "/api/internal/callbacks/trigger/cron": {
      return "trigger:cron";
    }
    case "/api/internal/callbacks/trigger/loop": {
      return "trigger:loop";
    }
    default: {
      return null;
    }
  }
}
