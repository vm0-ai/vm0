import { command } from "ccstate";
import { emailUnsubscribeContract } from "@vm0/api-contracts/contracts/email-unsubscribe";

import { env } from "../../lib/env";
import { queryOf } from "../context/request";
import {
  unsubscribeEmailUser$,
  verifyUnsubscribeToken,
} from "../services/email-unsubscribe.service";
import type { RouteEntry } from "../route-entry";

function missingTokenResponse() {
  return { status: 400 as const, body: { error: "Missing token" } };
}

function invalidTokenResponse() {
  return { status: 400 as const, body: { error: "Invalid token" } };
}

// The confirmation UI lives in the platform app; the API only redirects so a
// GET (e.g. a link-scanner prefetch) never unsubscribes anyone.
const getEmailUnsubscribe$ = command(async ({ get }, signal: AbortSignal) => {
  const query = get(queryOf(emailUnsubscribeContract.get));
  if (!query.token) {
    return missingTokenResponse();
  }

  const userId = await verifyUnsubscribeToken(query.token);
  signal.throwIfAborted();
  if (!userId) {
    return invalidTokenResponse();
  }

  const appUrl = env("APP_URL");
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${appUrl}/email/unsubscribe?token=${query.token}`,
      "Cache-Control": "no-store",
    },
  });
});

const postEmailUnsubscribe$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const query = get(queryOf(emailUnsubscribeContract.unsubscribe));
    if (!query.token) {
      return missingTokenResponse();
    }

    const userId = await verifyUnsubscribeToken(query.token);
    signal.throwIfAborted();
    if (!userId) {
      return invalidTokenResponse();
    }

    await set(unsubscribeEmailUser$, userId, signal);
    signal.throwIfAborted();

    return { status: 200 as const, body: { unsubscribed: true as const } };
  },
);

export const emailUnsubscribeRoutes: readonly RouteEntry[] = [
  {
    route: emailUnsubscribeContract.get,
    handler: getEmailUnsubscribe$,
  },
  {
    route: emailUnsubscribeContract.unsubscribe,
    handler: postEmailUnsubscribe$,
  },
];
