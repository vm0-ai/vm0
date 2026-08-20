import { command, type Command } from "ccstate";

import { providerUnavailable } from "../../lib/error";
import { setResHeader$ } from "../context/hono";
import { BillingClerkReadRateLimitError } from "../services/billing-clerk-directory.service";
import { settle } from "../utils";

const billingClerkUnavailable$ = command(
  ({ set }, retryAfterSeconds: number) => {
    set(setResHeader$, "Retry-After", String(retryAfterSeconds));
    set(setResHeader$, "Cache-Control", "no-store");
    return providerUnavailable(
      "Billing organization members are temporarily unavailable",
    );
  },
);

export function withBillingClerkRateLimit<T>(
  handler$: Command<Promise<T>, [AbortSignal]>,
): Command<Promise<T | ReturnType<typeof providerUnavailable>>, [AbortSignal]> {
  return command(async ({ set }, signal: AbortSignal) => {
    const result = await settle(set(handler$, signal), signal);
    if (result.ok) {
      return result.value;
    }
    if (!(result.error instanceof BillingClerkReadRateLimitError)) {
      throw result.error;
    }
    return set(billingClerkUnavailable$, result.error.retryAfterSeconds);
  });
}
