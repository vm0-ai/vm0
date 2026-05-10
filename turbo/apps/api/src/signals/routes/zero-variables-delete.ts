import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { zeroVariablesByNameContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { variables } from "@vm0/db/schema/variable";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route";

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroVariablesByNameContract.delete));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);
  // Atomic single-statement delete + 404 detection. Variables has no `type`
  // column (unlike secrets), so the WHERE clause is a 3-tuple.
  const deleted = await writeDb
    .delete(variables)
    .where(
      and(
        eq(variables.orgId, auth.orgId),
        eq(variables.userId, auth.userId),
        eq(variables.name, params.name),
      ),
    )
    .returning({ id: variables.id });
  signal.throwIfAborted();

  if (deleted.length === 0) {
    return notFound(`Variable "${params.name}" not found`);
  }
  return { status: 204 as const, body: undefined };
});

export const zeroVariablesDeleteRoutes: readonly RouteEntry[] = [
  {
    route: zeroVariablesByNameContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteInner$,
    ),
  },
];
