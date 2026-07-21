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

function confirmationHtmlResponse(): Response {
  const appUrl = env("APP_URL");
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Morning Brief turned off - VM0</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f9fc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; padding: 32px; border-radius: 8px; max-width: 480px; text-align: center; }
    h1 { font-size: 20px; color: #111827; margin: 0 0 12px; }
    p { font-size: 14px; color: #6b7280; line-height: 1.6; margin: 0 0 20px; }
    a { color: #2563eb; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Morning Brief turned off</h1>
    <p>You will no longer receive the daily Morning Brief email. You can turn it back on any time in Settings.</p>
    <p><a href="${appUrl}/settings">Manage preferences</a></p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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

const getMorningBriefUnsubscribe$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const query = get(queryOf(emailMorningBriefUnsubscribeContract.get));
    if (!query.token) {
      return missingTokenResponse();
    }
    const verified = verifyMorningBriefUnsubscribeToken(query.token);
    if (!verified) {
      return invalidTokenResponse();
    }
    await set(disableMorningBrief$, verified, signal);
    return confirmationHtmlResponse();
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
