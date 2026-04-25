import type { InitClientArgs, InitClientReturn } from "@ts-rest/core";
import type { AuthOptions } from "ably";
import type { platformRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { detach, Reason } from "../signals/utils.ts";
import { accept } from "./accept.ts";

type RealtimeTokenClient = InitClientReturn<
  typeof platformRealtimeTokenContract,
  InitClientArgs
>;

type AuthCallback = NonNullable<AuthOptions["authCallback"]>;

/**
 * Build an Ably `authCallback` that fetches a freshly-signed `TokenRequest`
 * from the platform token endpoint on every invocation.
 *
 * Ably invokes `authCallback` on the initial connect and again each time it
 * needs to renew the token (our endpoint issues requests with a 1 h ttl).
 * A `TokenRequest` is single-use — signed with a timestamp and ttl — so the
 * callback must hand Ably a fresh one every call; caching it causes renewal
 * to fail with "Client configured authentication provider request failed".
 *
 * The factory lives outside `signals/` so it can use `detach()` to track
 * the promise (Ably's API is node-style callback, not awaitable) and
 * `try/catch` to bridge that error surface into the callback's error
 * argument — both patterns are restricted inside `signals/`.
 */
export function createAblyAuthCallback(
  client: RealtimeTokenClient,
  signal: AbortSignal,
): AuthCallback {
  return (_params, callback) => {
    detach(
      (async () => {
        // eslint-disable-next-line no-restricted-syntax -- bridging Ably's node-style auth callback into our promise-based `accept()` helper; justified per eslint.config.js "If genuinely needed (JSON.parse, clipboard, polling), add an inline eslint-disable with justification"
        try {
          const res = await accept(
            client.create({ body: {}, fetchOptions: { signal } }),
            [200],
            { toast: false },
          );
          callback(null, res.body);
        } catch (error) {
          // Signal aborts happen because `setupRealtime$` already called
          // `ably.close()` — reporting that to Ably's callback would be
          // spurious noise (and in tests would trip the mock's "failed"
          // path during teardown).
          if (signal.aborted) {
            return;
          }
          callback(
            error instanceof Error ? error.message : String(error),
            null,
          );
        }
      })(),
      Reason.DomCallback,
      "ably-auth",
    );
  };
}
