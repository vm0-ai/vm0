import { computed } from "ccstate";
import { zeroTeamContract } from "@okouai/api-contracts/contracts/zero-team";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { teamComposeList } from "../services/agent-data.service";
import type { RouteEntry } from "../route-entry";

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

  const team = await get(teamComposeList(auth.orgId, auth.userId));
  return { status: 200 as const, body: [...team] };
});

export const teamRoutes: readonly RouteEntry[] = [
  {
    route: zeroTeamContract.list,
    handler: authRoute({}, listTeamInner$),
  },
];
