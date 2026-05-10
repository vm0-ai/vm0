import { command, computed, state, type Command } from "ccstate";

import { env } from "../env";
import { request$ } from "../../signals/context/hono";
import type { SignalRouteHandler } from "../../signals/context/route";
import { verifyEventConsumer, type EventConsumerPayload } from "./verify";

interface EventConsumerErrorResponse {
  readonly status: 401;
  readonly body: { readonly error: string };
}

const eventConsumerPayloadState$ = state<EventConsumerPayload | null>(null);

/**
 * Parsed event-consumer payload, available inside an `eventConsumerRoute`
 * scope. Follows the same set/read pattern as `authContext$`.
 */
export const eventConsumerPayload$ = computed((get): EventConsumerPayload => {
  const payload = get(eventConsumerPayloadState$);
  if (!payload) {
    throw new Error(
      "eventConsumerPayload$ accessed outside an eventConsumerRoute scope",
    );
  }
  return payload;
});

function isCommand<T>(
  handler$: SignalRouteHandler<T>,
): handler$ is Command<T, [AbortSignal]> {
  return "write" in handler$;
}

/**
 * Wrap an inner handler with HMAC signature verification.
 *
 * Reads the raw request body (single-shot stream consumption), verifies the
 * `X-VM0-Signature` / `X-VM0-Timestamp` headers against `SECRETS_ENCRYPTION_KEY`,
 * parses the JSON payload, and exposes it via `eventConsumerPayload$`.
 *
 * Mirrors `authRoute(options, handler$)` for HMAC-signed internal routes.
 */
export function eventConsumerRoute<T>(
  handler$: SignalRouteHandler<T>,
): Command<Promise<T | EventConsumerErrorResponse>, [AbortSignal]> {
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<T | EventConsumerErrorResponse> => {
      const req = get(request$);
      const rawBody = await req.text();
      signal.throwIfAborted();

      const result = verifyEventConsumer(
        rawBody,
        req.header("X-VM0-Signature") ?? null,
        req.header("X-VM0-Timestamp") ?? null,
        env("SECRETS_ENCRYPTION_KEY"),
      );

      if (!result.ok) {
        return { status: 401, body: { error: result.reason } };
      }

      set(eventConsumerPayloadState$, result.data);

      return isCommand(handler$)
        ? await set(handler$, signal)
        : await get(handler$);
    },
  );
}
