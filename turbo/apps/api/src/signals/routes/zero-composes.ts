import { computed } from "ccstate";
import { zeroComposesListContract } from "@vm0/api-contracts/contracts/zero-composes";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroComposeList } from "../services/zero-compose-data.service";
import type { RouteEntry } from "../route-entry";

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

export const zeroComposesRoutes: readonly RouteEntry[] = [
  {
    route: zeroComposesListContract.list,
    handler: authRoute(
      { acceptAnySandboxCapability: true },
      listComposesInner$,
    ),
  },
];
