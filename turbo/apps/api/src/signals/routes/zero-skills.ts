import { computed } from "ccstate";
import { zeroSkillsCollectionContract } from "@vm0/api-contracts/contracts/zero-agents";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroSkillList } from "../services/zero-catalog-data.service";
import type { RouteEntry } from "../route";

const listSkillsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const skills = await get(zeroSkillList(auth.orgId));
  return { status: 200 as const, body: [...skills] };
});

export const zeroSkillsRoutes: readonly RouteEntry[] = [
  {
    route: zeroSkillsCollectionContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent:read",
      },
      listSkillsInner$,
    ),
  },
];
