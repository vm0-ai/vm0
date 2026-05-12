import { computed } from "ccstate";
import { userExportContract } from "@vm0/api-contracts/contracts/user-export";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route";
import { userExportStatus } from "../services/user-export.service";

const getUserExportInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const body = await get(userExportStatus(auth.userId));

  return { status: 200 as const, body };
});

export const userExportRoutes: readonly RouteEntry[] = [
  {
    route: userExportContract.get,
    handler: authRoute({}, getUserExportInner$),
  },
];
