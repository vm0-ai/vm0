import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { zeroSecretsByNameContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { secrets } from "@vm0/db/schema/secret";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route";

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroSecretsByNameContract.delete));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);

  // Match web's filter: only user-type secrets are deletable through this
  // route. Connector / model-provider secrets are managed via dedicated routes.
  const deleted = await writeDb
    .delete(secrets)
    .where(
      and(
        eq(secrets.orgId, auth.orgId),
        eq(secrets.userId, auth.userId),
        eq(secrets.name, params.name),
        eq(secrets.type, "user"),
      ),
    )
    .returning({ id: secrets.id });
  signal.throwIfAborted();

  if (deleted.length === 0) {
    return notFound(`Secret "${params.name}" not found`);
  }
  return { status: 204 as const, body: undefined };
});

export const zeroSecretsDeleteRoutes: readonly RouteEntry[] = [
  {
    route: zeroSecretsByNameContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteInner$,
    ),
  },
];
