import { safeUrlParse } from "../utils";

export const internalRunCallbackKinds = ["agent"] as const;

export type InternalRunCallbackKind = (typeof internalRunCallbackKinds)[number];

export type InternalRunCallbackStatus = "completed" | "failed" | "progress";

export interface InternalRunCallbackEnvelope {
  readonly callbackId?: string;
  readonly runId: string;
  readonly status: InternalRunCallbackStatus;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly payload: unknown;
}

export function legacyInternalRunCallbackKind(
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
    default: {
      return null;
    }
  }
}
