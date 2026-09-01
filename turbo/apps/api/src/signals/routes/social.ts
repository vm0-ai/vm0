import {
  publicSocialErrorCode,
  publicSocialErrorMessage,
  socialContract,
} from "@okouai/api-contracts/contracts/social";
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
  SOCIALKIT_RECONCILIATION_TIMEOUT_MS,
} from "../services/socialkit-download.service";

const socialKitRequestBody$ = bodyResultOf(socialContract.request);
const socialKitDownloadBody$ = bodyResultOf(socialContract.createDownload);
const socialKitDownloadPathParams$ = pathParamsOf(socialContract.getDownload);
const socialKitDownloadNotFound = notFound("SocialKit download not found");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentFacing(auth: { readonly tokenType: string }): boolean {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox";
}

const PROVIDER_IDENTITY_KEYS = ["backend", "service", "source"] as const;

function isProviderIdentityKey(key: string): boolean {
  const normalized = key.replace(/[\s_-]/gu, "").toLowerCase();
  return (
    normalized.includes("provider") ||
    normalized.includes("vendor") ||
    PROVIDER_IDENTITY_KEYS.some((candidate) => {
      return candidate === normalized;
    })
  );
}

/**
 * Remove provider identity fields from JSON-shaped result extensions too.
 * Social result schemas intentionally preserve unknown JSON fields, so a
 * provider can otherwise reintroduce its own name below the response envelope.
 * Object-valued download metadata is retained; only identity strings are
 * removed.
 */
function redactProviderIdentity(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactProviderIdentity);
  }
  if (!isRecord(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (
      isProviderIdentityKey(key) &&
      typeof nested === "string" &&
      /socialkit(?:\.dev)?/iu.test(nested)
    ) {
      continue;
    }
    redacted[key] = redactProviderIdentity(nested);
  }
  return redacted;
}

/**
 * Remove upstream implementation details at the agent boundary. Internal
 * services keep the provider key for billing, reconciliation, and logs, but
 * neither the provider identity nor its diagnostics belong in agent context.
 */
function redactAgentSocialResponse<T>(response: T): T {
  if (!isRecord(response) || !isRecord(response.body)) {
    return response;
  }

  const body = response.body;
  const publicBody = redactProviderIdentity(body);
  if (!isRecord(publicBody)) {
    return response;
  }
  const error = publicBody.error;
  if (!isRecord(error)) {
    return { ...response, body: publicBody } as T;
  }

  const sanitizedBody = {
    ...publicBody,
    error: {
      ...error,
      ...(typeof error.code === "string"
        ? { code: publicSocialErrorCode(error.code) }
        : {}),
      ...(typeof error.message === "string"
        ? { message: publicSocialErrorMessage(error.message) }
        : {}),
    },
  };
  return { ...response, body: sanitizedBody } as T;
}

function agentSafeResponse<T>(
  auth: { readonly tokenType: string },
  response: T,
): T {
  return isAgentFacing(auth) ? redactAgentSocialResponse(response) : response;
}

const socialKitRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(socialKitRequestBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return agentSafeResponse(auth, bodyResult.response);
    }
    const response = await set(
      socialKitRequest$,
      { auth, body: bodyResult.data },
      signal,
    );
    return agentSafeResponse(auth, response);
  },
);

const createSocialKitDownloadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(socialKitDownloadBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return agentSafeResponse(auth, bodyResult.response);
    }
    const publicBrand =
      auth.tokenType === "agent" ? auth.publicBrand : get(publicBrand$);
    const reconciliationSignal = AbortSignal.timeout(
      SOCIALKIT_RECONCILIATION_TIMEOUT_MS,
    );
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
          reconciliationSignal,
        ),
      );
    }
    return agentSafeResponse(auth, response);
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
      return agentSafeResponse(auth, socialKitDownloadNotFound);
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
          AbortSignal.timeout(SOCIALKIT_RECONCILIATION_TIMEOUT_MS),
        ),
      );
    }
    return agentSafeResponse(auth, { status: 200 as const, body: response });
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
