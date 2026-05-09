// Browser-side fire-and-forget usage reporter for Plan D voice-chat
// realtime billing. Each `response.done` / `transcription.completed`
// extracted by `voice-chat-session.ts` enqueues here; this file
// immediately fires a `fetch` POST to `/api/zero/voice-chat/:id/usage`,
// logs warn on failure, and drops on the floor. No retry / no internal
// AbortController / no scheduler — Plan D's Epic body explicitly accepts
// "unreported usage as operational overhead", and the leader's call
// (option 2 after the ccstate-rule wall) was that the marginal
// resilience win of an in-memory retry queue isn't worth fighting the
// framework's signal-propagation rules. Browser crash / tab close mid-
// session is the dominant loss vector either way; resilience there is
// served by the `keepalive: true` flush on `pagehide`.
//
// Single-shot semantics:
//   • enqueue(event)           — fires fetch immediately, ignores response promise.
//   • flushKeepalive()         — for `pagehide` / `visibilitychange === "hidden"`.
//                                Re-fires every event seen so far via fetch
//                                keepalive so authenticated requests can outlive
//                                the page; this is best-effort, not idempotent.
//   • destroy()                — marks the reporter dead so further enqueues
//                                no-op. There's no in-flight retry to abort.
//
// In-memory only by design (Innovation §4): durable replay across crashes
// is not worth the complexity for a billing system whose Epic body
// explicitly accepts unreported usage as operational overhead.

import type { VoiceChatUsageEventBody } from "@vm0/api-contracts/contracts/zero-voice-chat";

import { logger } from "../../signals/log.ts";
import { detach, Reason } from "../../signals/utils.ts";

const L = logger("VoiceChatUsageReporter");

export type UsageReportPayload = VoiceChatUsageEventBody;

export interface UsageReporter {
  enqueue(event: UsageReportPayload): void;
  /**
   * Re-fire every previously enqueued event with `keepalive: true` so the
   * browser keeps the request alive past page unload. Call from
   * `pagehide` / `visibilitychange === "hidden"`. One-shot — not idempotent.
   */
  flushKeepalive(): void;
  /** Mark the reporter dead so further enqueues no-op. */
  destroy(): void;
}

interface CreateUsageReporterOptions {
  /** ts-rest-resolved apiBase (e.g. `https://api.vm0.ai`). */
  readonly apiBase: string;
  /**
   * Resolves a fresh Clerk JWT for the request's `Authorization` header.
   * Called per fetch so token rotation is naturally picked up.
   */
  readonly getAuthToken: () => Promise<string | null>;
  readonly voiceChatSessionId: string;
  /**
   * Path prefix under `apiBase` for the usage endpoint. Defaults to
   * `/api/zero/voice-chat`; the candidate variant overrides to
   * `/api/zero/voice-chat-candidate`.
   */
  readonly pathPrefix?: string;
  /**
   * Fired exactly once when the server responds with
   * `{ creditsExhausted: true }` to any usage event. Subsequent events
   * still drain, but the callback is suppressed to avoid double-firing
   * the session-end UX. Returning a Promise lets the reporter await it
   * — caller's signal chain stays intact.
   */
  readonly onCreditsExhausted: () => void | Promise<void>;
}

const DEFAULT_PATH_PREFIX = "/api/zero/voice-chat";

export function buildUsageEventUrl(
  apiBase: string,
  voiceChatSessionId: string,
  pathPrefix: string = DEFAULT_PATH_PREFIX,
): string {
  const trimmedBase = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
  const normalizedPrefix = pathPrefix.startsWith("/")
    ? pathPrefix
    : `/${pathPrefix}`;
  return `${trimmedBase}${normalizedPrefix}/${voiceChatSessionId}/usage`;
}

interface ParsedResponseBody {
  readonly creditsExhausted: boolean;
}

function isResponseBody(value: unknown): value is ParsedResponseBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "creditsExhausted" in value &&
    typeof (value as { creditsExhausted: unknown }).creditsExhausted ===
      "boolean"
  );
}

export function createUsageReporter(
  options: CreateUsageReporterOptions,
): UsageReporter {
  const url = buildUsageEventUrl(
    options.apiBase,
    options.voiceChatSessionId,
    options.pathPrefix,
  );
  // Track every payload sent so the keepalive flush can re-emit them on
  // unload. Plan D accepts duplicate-on-unload reports because the
  // server-side idempotency-key uniqueness collapses replays at the DB.
  const sent: UsageReportPayload[] = [];
  let destroyed = false;
  let creditsExhaustedFired = false;
  // Cached for the synchronous `flushKeepalive` path: pagehide fires too
  // late to await `getAuthToken()`. Refreshed lazily on every successful
  // drain (`getAuthToken` is invoked async; whatever it last returned
  // becomes the cached token used in keepalive flushes).
  let cachedToken: string | null = null;

  async function fireCreditsExhaustedOnce(): Promise<void> {
    if (creditsExhaustedFired) {
      return;
    }
    creditsExhaustedFired = true;
    await options.onCreditsExhausted();
  }

  async function fireOnceAsync(payload: UsageReportPayload): Promise<void> {
    sent.push(payload);
    const token = await options.getAuthToken();
    if (token === null || destroyed) {
      return;
    }
    cachedToken = token;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (destroyed) {
      return;
    }
    if (!response.ok) {
      L.warn("usage report failed — dropping (no retry)", {
        status: response.status,
        providerEventId: payload.providerEventId,
      });
      return;
    }
    const body = (await response.json()) as unknown;
    if (isResponseBody(body) && body.creditsExhausted) {
      await fireCreditsExhaustedOnce();
    }
  }

  function fireOnce(payload: UsageReportPayload): void {
    // detach() catches the rejection and logs it via the platform's
    // detached-promise channel. Network errors / JSON parse failures
    // surface there; Plan D treats them as accepted operational overhead.
    detach(fireOnceAsync(payload), Reason.DomCallback, "voice-chat usage");
  }

  return {
    enqueue(event) {
      if (destroyed) {
        return;
      }
      fireOnce(event);
    },
    flushKeepalive() {
      if (destroyed || cachedToken === null) {
        return;
      }
      // Re-fire every payload sent so far with keepalive: true so the
      // browser keeps the request alive past page unload. Server-side
      // idempotency-key uniqueness drops the duplicates.
      const token = cachedToken;
      for (const payload of sent) {
        // detach() handles rejection (logged through the detached-promise
        // channel). keepalive lets the browser keep the request alive
        // past page unload.
        detach(
          fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            keepalive: true,
          }),
          Reason.DomCallback,
          "voice-chat usage keepalive",
        );
      }
    },
    destroy() {
      destroyed = true;
    },
  };
}
