import { command } from "ccstate";
import { storagesCommitContract } from "@vm0/api-contracts/contracts/storages";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import { commitStorageUploadForAuth$ } from "../services/storage-write.service";

const commitBody$ = bodyResultOf(storagesCommitContract.commit);

const commitStorageInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const body = await get(commitBody$);
    signal.throwIfAborted();

    if (!body.ok) {
      return body.response;
    }

    return await set(
      commitStorageUploadForAuth$,
      { auth, ...body.data },
      signal,
    );
  },
);

export const storagesCommitRoutes: readonly RouteEntry[] = [
  {
    route: storagesCommitContract.commit,
    handler: authRoute(
      { acceptAnySandboxCapability: true },
      commitStorageInner$,
    ),
  },
];
