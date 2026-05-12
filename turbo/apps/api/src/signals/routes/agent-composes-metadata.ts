import { command } from "ccstate";
import { composesMetadataContract } from "@vm0/api-contracts/contracts/composes";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { badRequestMessage, isNotFoundResponse } from "../../lib/error";
import { updateComposeMetadata$ } from "../services/zero-compose-data.service";
import type { RouteEntry } from "../route";

const updateMetadataInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(composesMetadataContract.updateMetadata));
    const bodyResult = await get(
      bodyResultOf(composesMetadataContract.updateMetadata),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    if (!auth.orgId) {
      return badRequestMessage(
        "Explicit org context required — ensure active org in session",
      );
    }

    const result = await set(
      updateComposeMetadata$,
      {
        composeId: params.id,
        userId: auth.userId,
        orgId: auth.orgId,
        body: bodyResult.data,
      },
      signal,
    );
    signal.throwIfAborted();

    if (isNotFoundResponse(result)) {
      return result;
    }
    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const agentComposesMetadataRoutes: readonly RouteEntry[] = [
  {
    route: composesMetadataContract.updateMetadata,
    handler: authRoute(
      { acceptAnySandboxCapability: true },
      updateMetadataInner$,
    ),
  },
];
