import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { zeroCustomConnectorSecretContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route";

const deleteSecretInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroCustomConnectorSecretContract.delete));
    signal.throwIfAborted();

    const writeDb = set(writeDb$);
    await writeDb
      .delete(orgCustomConnectorSecrets)
      .where(
        and(
          eq(orgCustomConnectorSecrets.connectorId, params.id),
          eq(orgCustomConnectorSecrets.userId, auth.userId),
          eq(orgCustomConnectorSecrets.orgId, auth.orgId),
        ),
      );
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const zeroCustomConnectorSecretDeleteRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorSecretContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteSecretInner$,
    ),
  },
];
