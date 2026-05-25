import { command } from "ccstate";
import { zeroDebugSetCreditsContract } from "@vm0/api-contracts/contracts/zero-debug-credits";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

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

  const db = set(writeDb$);
  const [row] = await db
    .update(orgMetadata)
    .set({ credits: bodyResult.data.credits, updatedAt: nowDate() })
    .where(eq(orgMetadata.orgId, auth.orgId))
    .returning({ credits: orgMetadata.credits });
  signal.throwIfAborted();

  if (!row) {
    return notFound("Org not found");
  }

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
