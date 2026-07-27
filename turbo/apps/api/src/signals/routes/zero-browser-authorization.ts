import { command } from "ccstate";
import { zeroBrowserAuthorizationRequestsContract } from "@vm0/api-contracts/contracts/zero-browser";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  applyBrowserAuthorizationRequest$,
  createBrowserAuthorizationRequest$,
  readBrowserAuthorizationRequest$,
} from "../services/zero-browser-authorization.service";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

function expired() {
  return {
    status: 410 as const,
    body: {
      error: {
        message: "Cloud browser authorization request expired",
        code: "GONE",
      },
    },
  };
}

const unsupportedContext = conflict(
  "Cloud browser authorization links are only available from chat thread runs",
);

const createBody$ = bodyResultOf(
  zeroBrowserAuthorizationRequestsContract.create,
);
const getParams$ = pathParamsOf(zeroBrowserAuthorizationRequestsContract.get);
const applyParams$ = pathParamsOf(
  zeroBrowserAuthorizationRequestsContract.apply,
);
const applyBody$ = bodyResultOf(zeroBrowserAuthorizationRequestsContract.apply);

const browserAuthorizationAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const browserAuthorizationCreateAuthOptions = {
  ...browserAuthorizationAuthOptions,
  acceptAnySandboxCapability: true,
  accept: ["zero", "sandbox"],
} as const;

const createAuthorizationRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(createBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (auth.tokenType !== "zero" && auth.tokenType !== "sandbox") {
      return badRequestMessage(
        "Cloud browser authorization requires a run token",
      );
    }

    const result = await set(
      createBrowserAuthorizationRequest$,
      { orgId: auth.orgId, userId: auth.userId, runId: auth.runId },
      signal,
    );
    signal.throwIfAborted();
    if (result.status === "run_not_found") {
      return notFound("Run not found");
    }
    if (result.status === "unsupported_context") {
      return unsupportedContext;
    }
    return {
      status: 200 as const,
      body: {
        authorizationUrl: result.authorizationUrl,
        expiresAt: result.expiresAt,
      },
    };
  },
);

const getAuthorizationRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const result = await set(
      readBrowserAuthorizationRequest$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        requestToken: get(getParams$).requestToken,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.status === "not_found") {
      return notFound("Cloud browser authorization request not found");
    }
    if (result.status === "expired") {
      return expired();
    }
    return {
      status: 200 as const,
      body: {
        expiresAt: result.expiresAt,
        completedAt: result.completedAt,
        cloudBrowserEnabled: result.cloudBrowserEnabled,
      },
    };
  },
);

const applyAuthorizationRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(applyBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(
      applyBrowserAuthorizationRequest$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        requestToken: get(applyParams$).requestToken,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.status === "not_found") {
      return notFound("Cloud browser authorization request not found");
    }
    if (result.status === "expired") {
      return expired();
    }
    if (result.status === "scope_not_found") {
      return notFound("Cloud browser authorization scope not found");
    }
    return {
      status: 200 as const,
      body: { ok: true as const, cloudBrowserEnabled: true as const },
    };
  },
);

export const zeroBrowserAuthorizationRoutes: readonly RouteEntry[] = [
  {
    route: zeroBrowserAuthorizationRequestsContract.create,
    handler: authRoute(
      browserAuthorizationCreateAuthOptions,
      createAuthorizationRequestInner$,
    ),
  },
  {
    route: zeroBrowserAuthorizationRequestsContract.get,
    handler: authRoute(
      browserAuthorizationAuthOptions,
      getAuthorizationRequestInner$,
    ),
  },
  {
    route: zeroBrowserAuthorizationRequestsContract.apply,
    handler: authRoute(
      browserAuthorizationAuthOptions,
      applyAuthorizationRequestInner$,
    ),
  },
];
