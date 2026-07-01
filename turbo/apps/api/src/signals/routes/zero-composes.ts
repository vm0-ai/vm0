import { computed } from "ccstate";
import {
  zeroComposesByIdContract,
  zeroComposesListContract,
} from "@vm0/api-contracts/contracts/zero-composes";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import {
  zeroComposeById,
  zeroComposeList,
} from "../services/zero-compose-data.service";
import type { RouteEntry } from "../route-entry";

const getComposeByIdInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroComposesByIdContract.getById));
  const compose = await get(
    zeroComposeById({
      composeId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );
  if (!compose) {
    return notFound("Agent compose not found");
  }

  return { status: 200 as const, body: compose };
});

const listComposesInner$ = computed(async (get) => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return {
      status: 400 as const,
      body: { error: { message: "Invalid request", code: "BAD_REQUEST" } },
    };
  }

  const result = await get(zeroComposeList(auth.orgId));
  return { status: 200 as const, body: { composes: [...result.composes] } };
});

const orgAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const zeroComposesRoutes: readonly RouteEntry[] = [
  {
    route: zeroComposesListContract.list,
    handler: authRoute(
      { acceptAnySandboxCapability: true },
      listComposesInner$,
    ),
  },
  {
    route: zeroComposesByIdContract.getById,
    handler: authRoute(orgAuth, getComposeByIdInner$),
  },
];
