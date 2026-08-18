import { command } from "ccstate";
import { usageMembersContract } from "@okouai/api-contracts/contracts/usage";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { usageMembers$ } from "../services/usage.service";
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
    const query = get(queryOf(usageMembersContract.get));
    const range = query.range ?? "billingPeriod";
    const tz = query.tz ?? "UTC";

    if (auth.orgRole !== "admin") {
      return forbidden();
    }
    if (!isValidTimeZone(tz)) {
      return badRequestMessage(`Invalid timezone: ${tz}`);
    }

    const body = await set(
      usageMembers$,
      { orgId: auth.orgId, range, tz },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const usageMembersRoutes: readonly RouteEntry[] = [
  {
    route: usageMembersContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUsageMembersInner$,
    ),
  },
];
