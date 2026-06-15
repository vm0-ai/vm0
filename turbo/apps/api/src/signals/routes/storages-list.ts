import { computed } from "ccstate";
import { storagesListContract } from "@vm0/api-contracts/contracts/storages";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route";
import { listStoragesForAuth } from "../services/storage-read.service";

const listStoragesInner$ = computed((get) => {
  const auth = get(authContext$);
  const query = get(queryOf(storagesListContract.list));

  return get(listStoragesForAuth({ auth, type: query.type }));
});

export const storagesListRoutes: readonly RouteEntry[] = [
  {
    route: storagesListContract.list,
    handler: authRoute(
      { acceptAnySandboxCapability: true },
      listStoragesInner$,
    ),
  },
];
