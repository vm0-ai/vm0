import type { BrowserOptions } from "@sentry/browser";

import {
  recordSentryException,
  recordSentryInitialization,
  recordSentryMessage,
  recordSentryUser,
} from "./sentry-behavior.ts";

export function init(options?: BrowserOptions): void {
  recordSentryInitialization("page", options);
}

export function captureException(
  error: unknown,
  context?: Parameters<typeof import("@sentry/react").captureException>[1],
): string {
  return recordSentryException("page", error, context);
}

export function captureMessage(
  message: string,
  context?: Parameters<typeof import("@sentry/react").captureMessage>[1],
): string {
  return recordSentryMessage("page", message, context);
}

export function setUser(
  user: Parameters<typeof import("@sentry/react").setUser>[0],
): void {
  recordSentryUser(user);
}
