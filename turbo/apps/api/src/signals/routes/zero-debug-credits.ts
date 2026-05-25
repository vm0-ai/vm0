import { command } from "ccstate";
import { zeroDebugSetCreditsContract } from "@vm0/api-contracts/contracts/zero-debug-credits";
import { orgMetadata } from "@vm0/db/schema/org-metadata";

import { env } from "../../lib/env";
import { notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route";

const setCreditsAuthed$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  signal.throwIfAborted();

  const bodyResult = await get(
    bodyResultOf(zeroDebugSetCreditsContract.create),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const { credits } = bodyResult.data;
  const db = set(writeDb$);
  // Upsert: fresh orgs may not have an org_metadata row yet (the starter
  // grant only runs on onboarding / first CLI auth), so a plain UPDATE
  // would silently miss and 404. Insert with the requested balance, and
  // update credits + updatedAt on conflict — preserve any existing tier
  // / Stripe / auto-recharge fields.
  const rows = await db
    .insert(orgMetadata)
    .values({ orgId: auth.orgId, credits })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { credits, updatedAt: nowDate() },
    })
    .returning({ credits: orgMetadata.credits });
  signal.throwIfAborted();
  // Upsert with conflict-target always returns exactly one row.
  const row = rows[0] ?? { credits };

  return { status: 200 as const, body: { credits: row.credits } };
});

const setCredits$ = command(async ({ set }, signal: AbortSignal) => {
  if (env("ENV") === "production") {
    return notFound("Not found");
  }
  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setCreditsAuthed$,
    ),
    signal,
  );
});

export const zeroDebugCreditsRoutes: readonly RouteEntry[] = [
  {
    route: zeroDebugSetCreditsContract.create,
    handler: setCredits$,
  },
];
