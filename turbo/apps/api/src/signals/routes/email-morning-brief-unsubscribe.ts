import { command } from "ccstate";
import { emailMorningBriefUnsubscribeContract } from "@vm0/api-contracts/contracts/email-morning-brief-unsubscribe";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";

import { env } from "../../lib/env";
import { queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { verifyMorningBriefUnsubscribeToken } from "../services/morning-brief-email-link.service";
import { syncMorningBriefSchedule } from "../services/morning-brief-schedule.service";
import type { RouteEntry } from "../route-entry";

function missingTokenResponse() {
  return { status: 400 as const, body: { error: "Missing token" } };
}

function invalidTokenResponse() {
  return { status: 400 as const, body: { error: "Invalid token" } };
}

const disableMorningBrief$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const updatedAt = nowDate();
    await db
      .insert(orgMembersMetadata)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        morningBriefEnabled: false,
        createdAt: updatedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: { morningBriefEnabled: false, updatedAt },
      });
    signal.throwIfAborted();
    await syncMorningBriefSchedule(db, {
      orgId: args.orgId,
      userId: args.userId,
      timezone: null,
      enabled: false,
      currentTime: updatedAt,
    });
    signal.throwIfAborted();
  },
);

// Links in already-sent emails point at this API route. The unsubscribe page
// now lives in the platform app, so forward the browser there with the token.
// Rollout compatibility: the API can go live before the platform bundle that
// serves the target route, so a valid token is still unsubscribed here before
// redirecting; the platform page's POST is an idempotent no-op afterwards.
// Remove the side effect once the platform route has fully rolled out.
const getMorningBriefUnsubscribe$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const query = get(queryOf(emailMorningBriefUnsubscribeContract.get));
    if (query.token) {
      const verified = verifyMorningBriefUnsubscribeToken(query.token);
      if (verified) {
        await set(disableMorningBrief$, verified, signal);
      }
    }
    const target = new URL(`${env("APP_URL")}/email/morning-brief/unsubscribe`);
    if (query.token) {
      target.searchParams.set("token", query.token);
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: target.toString(),
        "Cache-Control": "no-store",
      },
    });
  },
);

const postMorningBriefUnsubscribe$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const query = get(
      queryOf(emailMorningBriefUnsubscribeContract.unsubscribe),
    );
    if (!query.token) {
      return missingTokenResponse();
    }
    const verified = verifyMorningBriefUnsubscribeToken(query.token);
    if (!verified) {
      return invalidTokenResponse();
    }
    await set(disableMorningBrief$, verified, signal);
    return { status: 200 as const, body: { unsubscribed: true as const } };
  },
);

export const emailMorningBriefUnsubscribeRoutes: readonly RouteEntry[] = [
  {
    route: emailMorningBriefUnsubscribeContract.get,
    handler: getMorningBriefUnsubscribe$,
  },
  {
    route: emailMorningBriefUnsubscribeContract.unsubscribe,
    handler: postMorningBriefUnsubscribe$,
  },
];
