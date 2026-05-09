import { computed } from "ccstate";
import { apiKeysContract } from "@vm0/api-contracts/contracts/api-keys";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route";
import { userApiKeys } from "../services/zero-user-data.service";

const listApiKeysInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(authContext$);
  const body = await get(userApiKeys(auth.userId));
  return {
    status: 200 as const,
    body,
  };
});

export const zeroApiKeysRoutes: readonly RouteEntry[] = [
  {
    route: apiKeysContract.list,
    handler: authRoute({}, listApiKeysInner$),
  },
];
