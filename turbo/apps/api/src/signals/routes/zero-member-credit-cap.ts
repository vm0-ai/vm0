import { command, computed } from "ccstate";
import { zeroMemberCreditCapContract } from "@vm0/api-contracts/contracts/zero-member-credit-cap";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import {
  setMemberCreditCap$,
  zeroMemberCreditCap,
} from "../services/zero-member-credit-cap.service";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can update member credit caps",
      code: "FORBIDDEN",
    }),
  }),
});

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

const setMemberCreditCapInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    const bodyResult = await get(bodyResultOf(zeroMemberCreditCapContract.set));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      setMemberCreditCap$,
      {
        orgId: auth.orgId,
        userId: bodyResult.data.userId,
        creditCap: bodyResult.data.creditCap,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        userId: bodyResult.data.userId,
        creditCap: result.creditCap,
        creditEnabled: result.creditEnabled,
      },
    };
  },
);

export const zeroMemberCreditCapRoutes: readonly RouteEntry[] = [
  {
    route: zeroMemberCreditCapContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getMemberCreditCapInner$,
    ),
  },
  {
    route: zeroMemberCreditCapContract.set,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setMemberCreditCapInner$,
    ),
  },
];
