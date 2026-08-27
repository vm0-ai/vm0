import { socialContract } from "@okouai/api-contracts/contracts/social";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { publicBrand$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";
import { socialKitRequest$ } from "../services/social.service";
import {
  createSocialKitDownload$,
  getSocialKitDownload$,
  reconcileSocialKitDownload$,
} from "../services/socialkit-download.service";

const socialKitRequestBody$ = bodyResultOf(socialContract.request);
const socialKitDownloadBody$ = bodyResultOf(socialContract.createDownload);
const socialKitDownloadPathParams$ = pathParamsOf(socialContract.getDownload);
const socialKitDownloadNotFound = notFound("SocialKit download not found");

const socialKitRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(socialKitRequestBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      socialKitRequest$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const createSocialKitDownloadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(socialKitDownloadBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const publicBrand =
      auth.tokenType === "agent" ? auth.publicBrand : get(publicBrand$);
    const response = await set(
      createSocialKitDownload$,
      { auth, body: bodyResult.data, publicBrand },
      signal,
    );
    if (response.status === 202) {
      waitUntil(
        set(
          reconcileSocialKitDownload$,
          response.body.downloadId,
          AbortSignal.timeout(12 * 60_000),
        ),
      );
    }
    return response;
  },
);

const getSocialKitDownloadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(socialKitDownloadPathParams$);
    const response = await set(
      getSocialKitDownload$,
      {
        downloadId: params.downloadId,
        orgId: auth.orgId,
        userId: auth.userId,
      },
      signal,
    );
    if (!response) {
      return socialKitDownloadNotFound;
    }
    if (
      response.status === "processing" ||
      response.status === "materializing" ||
      response.status === "artifact_failed"
    ) {
      waitUntil(
        set(
          reconcileSocialKitDownload$,
          response.downloadId,
          AbortSignal.timeout(12 * 60_000),
        ),
      );
    }
    return { status: 200 as const, body: response };
  },
);

export const socialRoutes: readonly RouteEntry[] = [
  {
    route: socialContract.request,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "social:read",
      },
      socialKitRequestInner$,
    ),
  },
  {
    route: socialContract.createDownload,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "social:read",
      },
      createSocialKitDownloadInner$,
    ),
  },
  {
    route: socialContract.getDownload,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "social:read",
      },
      getSocialKitDownloadInner$,
    ),
  },
];
