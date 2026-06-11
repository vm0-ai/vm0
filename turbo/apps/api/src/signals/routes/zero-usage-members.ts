import { command } from "ccstate";
import { zeroUsageMembersContract } from "@vm0/api-contracts/contracts/zero-usage";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route";
import { zeroUsageMembers$ } from "../services/zero-usage.service";
import { isValidTimeZone } from "../utils";

function forbidden() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Only org admins can view member usage",
        code: "FORBIDDEN",
      },
    },
  };
}

const getUsageMembersInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(zeroUsageMembersContract.get));
    const range = query.range ?? "billingPeriod";
    const tz = query.tz ?? "UTC";

    if (auth.orgRole !== "admin") {
      return forbidden();
    }
    if (!isValidTimeZone(tz)) {
      return badRequestMessage(`Invalid timezone: ${tz}`);
    }

    const body = await set(
      zeroUsageMembers$,
      { orgId: auth.orgId, range, tz },
      signal,
    );
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
