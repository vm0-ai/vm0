import { computed } from "ccstate";
import { zeroMemberCreditCapContract } from "@vm0/api-contracts/contracts/zero-member-credit-cap";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { shadowCompareRoute } from "../context/shadow-compare";
import { zeroMemberCreditCap } from "../services/zero-member-credit-cap.service";
import type { RouteEntry } from "../route";

const getMemberCreditCapInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(zeroMemberCreditCapContract.get));
  const result = await get(
    zeroMemberCreditCap({ orgId: auth.orgId, userId: query.userId }),
  );

  return {
    status: 200 as const,
    body: {
      userId: query.userId,
      creditCap: result.creditCap,
      creditEnabled: result.creditEnabled,
    },
  };
});

export const zeroMemberCreditCapRoutes: readonly RouteEntry[] = [
  {
    route: zeroMemberCreditCapContract.get,
    handler: shadowCompareRoute({
      route: zeroMemberCreditCapContract.get,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        getMemberCreditCapInner$,
      ),
    }),
  },
];
