import { command } from "ccstate";
import { zeroOrgDeleteContract } from "@vm0/api-contracts/contracts/zero-org";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { deleteZeroOrg$ } from "../services/zero-org-data.service";
import type { RouteEntry } from "../route";

const deleteBody$ = bodyResultOf(zeroOrgDeleteContract.delete);

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(deleteBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const result = await set(
    deleteZeroOrg$,
    {
      orgId: auth.orgId,
      callerRole: auth.orgRole,
      slug: body.data.slug,
    },
    signal,
  );
  signal.throwIfAborted();

  if ("status" in result) {
    return result;
  }

  return { status: 200 as const, body: result };
});

export const zeroOrgDeleteRoutes: readonly RouteEntry[] = [
  {
    route: zeroOrgDeleteContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteInner$,
    ),
  },
];
