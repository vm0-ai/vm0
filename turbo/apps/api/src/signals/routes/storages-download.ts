import { computed } from "ccstate";
import { storagesDownloadContract } from "@vm0/api-contracts/contracts/storages";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route";
import { downloadStorageForAuth } from "../services/storage-read.service";

const downloadStorageInner$ = computed((get) => {
  const auth = get(authContext$);
  const query = get(queryOf(storagesDownloadContract.download));

  return get(
    downloadStorageForAuth({
      auth,
      name: query.name,
      type: query.type,
      version: query.version,
    }),
  );
});

export const storagesDownloadRoutes: readonly RouteEntry[] = [
  {
    route: storagesDownloadContract.download,
    handler: authRoute(
      { acceptAnySandboxCapability: true },
      downloadStorageInner$,
    ),
  },
];
