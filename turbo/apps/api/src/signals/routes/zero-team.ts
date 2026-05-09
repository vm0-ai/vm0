import { computed } from "ccstate";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroTeam } from "../services/zero-agent-data.service";
import type { RouteEntry } from "../route";

const noActiveOrg = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "No active organization. Please select an org.",
      code: "FORBIDDEN",
    }),
  }),
});

const listTeamInner$ = computed(async (get) => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return noActiveOrg;
  }

  const team = await get(zeroTeam(auth.orgId));
  return { status: 200 as const, body: [...team] };
});

export const zeroTeamRoutes: readonly RouteEntry[] = [
  {
    route: zeroTeamContract.list,
    handler: authRoute({}, listTeamInner$),
  },
];
