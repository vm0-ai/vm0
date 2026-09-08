import type { BrowserOptions, ErrorEvent } from "@sentry/browser";
import { expect, test } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { SharedDatabaseHttpError } from "../../shared-database/http-error.ts";
import {
  deserializeSharedDatabaseError,
  serializeSharedDatabaseError,
} from "../../shared-database/protocol.ts";
import { initSharedDatabaseWorkerSentry } from "../../shared-database/worker-sentry.ts";
import { ApiError } from "../api-error.ts";
import { captureSentryLogError } from "../sentry-config.ts";
import { initSentry } from "../sentry.ts";

const context = testContext();
const SAFARI_PERMISSION_MESSAGE =
  "The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.";
const WEBKIT_MEDIA_MESSAGE =
  "this.mediaController.media.addEventListener is not a function";
const WEBKIT_SAFARI_MESSAGE = `${WEBKIT_MEDIA_MESSAGE}. (In 'this.mediaController.media.addEventListener(eventType,this,true)', 'this.mediaController.media.addEventListener' is undefined)`;

// Exercise the SDK hooks installed by the production page/worker entrypoints.
// The external Sentry mock records capture attempts; beforeSend owns delivery.
function startSentry(
  runtime: "page" | "shared-worker",
): NonNullable<BrowserOptions["beforeSend"]> {
  const sentry = context.mocks.sentry();
  if (runtime === "page") {
    initSentry();
  } else {
    initSharedDatabaseWorkerSentry();
  }
  const beforeSend = sentry.initializations.at(-1)?.options?.beforeSend;
  if (!beforeSend) {
    throw new Error("Expected the production Sentry delivery hook");
  }
  return beforeSend;
}

test.each(["page", "shared-worker"] as const)(
  "filters expected raw and wrapped captures in %s",
  async (runtime) => {
    const beforeSend = startSentry(runtime);
    const expected = [
      new Error("Connection to server unavailable"),
      new Error("Channel attach timed out"),
      new DOMException("Permission denied by system", "NotAllowedError"),
      new DOMException(SAFARI_PERMISSION_MESSAGE, "NotAllowedError"),
      new Error("NotAllowedError: Permission denied by system"),
      new TypeError(WEBKIT_MEDIA_MESSAGE),
      new TypeError(WEBKIT_SAFARI_MESSAGE),
      new SharedDatabaseHttpError(401),
      new SharedDatabaseHttpError(426),
      new ApiError("Unauthorized", "UNAUTHORIZED", 401),
      new ApiError("Client update required", "CLIENT_UPGRADE_REQUIRED", 426),
    ];
    for (const error of expected) {
      const transferred = deserializeSharedDatabaseError(
        serializeSharedDatabaseError(error),
      );
      for (const captured of [
        error,
        transferred,
        new Error("Voice draft recording failed", {
          cause: new Error("Operation failed", { cause: transferred }),
        }),
      ]) {
        captureSentryLogError("ExpectedFailure", [
          "Operation failed",
          captured,
        ]);
        const report = context.mocks.sentry().reports.at(-1);
        expect(report).toMatchObject({ type: "exception", error: captured });
        const event: ErrorEvent = {
          type: undefined,
          exception: { values: [{ type: "Error", value: "Operation failed" }] },
        };
        await expect(
          Promise.resolve(beforeSend(event, { originalException: captured })),
        ).resolves.toBeNull();
      }
    }
  },
);

test.each(["page", "shared-worker"] as const)(
  "filters native and linked exceptions without an original object in %s",
  async (runtime) => {
    const beforeSend = startSentry(runtime);
    for (const exception of [
      { type: "Error", value: "Connection to server unavailable" },
      { type: "Error", value: "Channel attach timed out" },
      { type: "NotAllowedError", value: SAFARI_PERMISSION_MESSAGE },
      { type: "Error", value: "NotAllowedError: Permission denied by system" },
      { type: "TypeError", value: WEBKIT_MEDIA_MESSAGE },
      { type: "TypeError", value: WEBKIT_SAFARI_MESSAGE },
    ]) {
      const event: ErrorEvent = {
        type: undefined,
        exception: {
          values: [
            exception,
            { type: "Error", value: "Voice draft recording failed" },
          ],
        },
      };
      await expect(Promise.resolve(beforeSend(event, {}))).resolves.toBeNull();
    }
  },
);

test.each(["page", "shared-worker"] as const)(
  "preserves unexpected failures in %s",
  async (runtime) => {
    const beforeSend = startSentry(runtime);
    for (const error of [
      new Error("Voice draft recording failed", {
        cause: new Error("Storage write failed"),
      }),
      new DOMException("Recorder failed", "NotReadableError"),
      new Error("Transcription failed"),
      new Error("Ably subscription callback failed"),
      new Error("Channel attach timed out while running application code"),
      new TypeError("audio.addEventListener is not a function"),
      new Error("Unexpected Chat Event schema version null"),
      new SharedDatabaseHttpError(500),
      new ApiError("Internal server error", "INTERNAL_SERVER_ERROR", 500),
      deserializeSharedDatabaseError(
        serializeSharedDatabaseError(
          new ApiError("Internal server error", "INTERNAL_SERVER_ERROR", 500),
        ),
      ),
      deserializeSharedDatabaseError(
        serializeSharedDatabaseError(new SharedDatabaseHttpError(500)),
      ),
    ]) {
      const event: ErrorEvent = {
        type: undefined,
        exception: { values: [{ type: error.name, value: error.message }] },
      };
      await expect(
        Promise.resolve(
          beforeSend(event, {
            originalException: new Error("Operation failed", { cause: error }),
          }),
        ),
      ).resolves.toBe(event);
      await expect(Promise.resolve(beforeSend(event, {}))).resolves.toBe(event);
    }
    const event: ErrorEvent = {
      type: undefined,
      contexts: { response: { status_code: 500 } },
    };
    await expect(Promise.resolve(beforeSend(event, {}))).resolves.toBe(event);
    await expect(
      Promise.resolve(
        beforeSend(
          { type: undefined, contexts: { response: { status_code: 401 } } },
          {},
        ),
      ),
    ).resolves.toBeNull();
    await expect(
      Promise.resolve(
        beforeSend(
          { type: undefined, contexts: { response: { status_code: 426 } } },
          {},
        ),
      ),
    ).resolves.toBeNull();
  },
);
