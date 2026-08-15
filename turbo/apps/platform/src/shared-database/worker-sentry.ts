import * as Sentry from "@sentry/browser";

import {
  createPlatformSentryOptions,
  setupSentryLogger,
} from "../lib/sentry-config.ts";

export function initSharedDatabaseWorkerSentry(): void {
  Sentry.init(createPlatformSentryOptions("shared-worker"));
  setupSentryLogger();
}
