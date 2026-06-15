import { command } from "ccstate";
import { storagesPrepareContract } from "@vm0/api-contracts/contracts/storages";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import { prepareStorageUploadForAuth$ } from "../services/storage-write.service";

const prepareBody$ = bodyResultOf(storagesPrepareContract.prepare);

const prepareStorageInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const body = await get(prepareBody$);
    signal.throwIfAborted();

    if (!body.ok) {
      return body.response;
    }

    return await set(
      prepareStorageUploadForAuth$,
      { auth, ...body.data },
      signal,
    );
  },
);

export const storagesPrepareRoutes: readonly RouteEntry[] = [
  {
    route: storagesPrepareContract.prepare,
    handler: authRoute(
      { acceptAnySandboxCapability: true },
      prepareStorageInner$,
    ),
  },
];
