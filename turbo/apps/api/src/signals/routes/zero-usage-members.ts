import { command } from "ccstate";
import { zeroUsageMembersContract } from "@vm0/api-contracts/contracts/zero-usage";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route";
import { zeroUsageMembers$ } from "../services/zero-usage.service";

const getUsageMembersInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await set(zeroUsageMembers$, { orgId: auth.orgId }, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const zeroUsageMembersRoutes: readonly RouteEntry[] = [
  {
    route: zeroUsageMembersContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUsageMembersInner$,
    ),
  },
];
