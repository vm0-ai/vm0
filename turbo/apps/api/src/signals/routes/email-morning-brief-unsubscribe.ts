import { command } from "ccstate";
import { emailMorningBriefUnsubscribeContract } from "@okouai/api-contracts/contracts/email-morning-brief-unsubscribe";

import { queryOf } from "../context/request";
import { verifyMorningBriefUnsubscribeToken } from "../services/morning-brief-email-link.service";
import type { RouteEntry } from "../route-entry";

function missingTokenResponse() {
  return { status: 400 as const, body: { error: "Missing token" } };
}

function invalidTokenResponse() {
  return { status: 400 as const, body: { error: "Invalid token" } };
}

const postMorningBriefUnsubscribe$ = command(({ get }) => {
  const query = get(queryOf(emailMorningBriefUnsubscribeContract.unsubscribe));
  if (!query.token) {
    return missingTokenResponse();
  }
  const verified = verifyMorningBriefUnsubscribeToken(query.token);
  if (!verified) {
    return invalidTokenResponse();
  }
  // Deployment fallback for already-delivered email links and old loaded App
  // bundles. The phase-A migration already makes the preference terminal;
  // phase B removes this idempotent endpoint after #30264's released
  // zero-traffic gate and the replacement App version floor.
  return { status: 200 as const, body: { unsubscribed: true as const } };
});

export const emailMorningBriefUnsubscribeRoutes: readonly RouteEntry[] = [
  {
    route: emailMorningBriefUnsubscribeContract.unsubscribe,
    handler: postMorningBriefUnsubscribe$,
  },
];
