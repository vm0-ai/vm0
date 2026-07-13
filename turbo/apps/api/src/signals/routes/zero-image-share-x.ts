import { command } from "ccstate";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { zeroImageShareXContract } from "@vm0/api-contracts/contracts/zero-image-share-x";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { shareImageToX$ } from "../services/zero-image-share-x.service";

const imageShareXBody$ = bodyResultOf(zeroImageShareXContract.post);

const postImageShareXInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(imageShareXBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const auth = get(organizationAuthContext$);
    const result = await set(
      shareImageToX$,
      {
        caption: bodyResult.data.caption,
        imageUrl: bodyResult.data.imageUrl,
        orgId: auth.orgId,
        userId: auth.userId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      return createErrorResponse(result.errorKey, result.message);
    }

    return {
      status: 200 as const,
      body: {
        tweetId: result.tweetId,
        tweetUrl: result.tweetUrl,
      },
    };
  },
);

export const zeroImageShareXRoutes: readonly RouteEntry[] = [
  {
    route: zeroImageShareXContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      postImageShareXInner$,
    ),
  },
];
