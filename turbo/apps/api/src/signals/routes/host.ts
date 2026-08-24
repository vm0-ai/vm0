import { command } from "ccstate";
import { hostContract } from "@okouai/api-contracts/contracts/host";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { publicBrand$ } from "../context/hono";
import {
  completeHostedSiteDeployment$,
  getHostedSiteDeployments$,
  getHostedSiteFiles$,
  prepareHostedSiteDeployment$,
} from "../services/host.service";
import { rejectSuspendedOrg$ } from "../services/org-suspension.service";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

function internalError(message: string) {
  return {
    status: 500 as const,
    body: {
      error: { message, code: "INTERNAL_SERVER_ERROR" },
    },
  };
}

const prepareBody$ = bodyResultOf(hostContract.prepare);
const prepareInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const publicBrand =
    auth.tokenType === "agent" ? auth.publicBrand : get(publicBrand$);

  const bodyResult = await get(prepareBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
  if (suspended) {
    return suspended;
  }

  const result = await set(
    prepareHostedSiteDeployment$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      runId: "runId" in auth ? auth.runId : undefined,
      publicBrand,
      body: bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "bad_request") {
    return badRequestMessage(result.message);
  }
  if (result.status === "conflict") {
    return conflict(result.message);
  }
  if (result.status === "config_error") {
    return internalError(result.message);
  }

  return { status: 200 as const, body: result.body };
});

const completeParams$ = pathParamsOf(hostContract.complete);
const filesParams$ = pathParamsOf(hostContract.files);
const filesQuery$ = queryOf(hostContract.files);
const deploymentsParams$ = pathParamsOf(hostContract.deployments);
const completeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const params = get(completeParams$);
  const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
  if (suspended) {
    return suspended;
  }

  const result = await set(
    completeHostedSiteDeployment$,
    {
      orgId: auth.orgId,
      runId: "runId" in auth ? auth.runId : undefined,
      deploymentId: params.deploymentId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "bad_request") {
    return badRequestMessage(result.message);
  }
  if (result.status === "conflict") {
    return conflict(result.message);
  }
  if (result.status === "not_found") {
    return notFound(result.message);
  }
  if (result.status === "config_error") {
    return internalError(result.message);
  }

  return { status: 200 as const, body: result.body };
});

const filesInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(filesParams$);
  const query = get(filesQuery$);

  const result = await set(
    getHostedSiteFiles$,
    {
      orgId: auth.orgId,
      publicSlug: params.publicSlug,
      version: query.version,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "conflict") {
    return conflict(result.message);
  }
  if (result.status === "not_found") {
    return notFound(result.message);
  }
  if (result.status === "config_error") {
    return internalError(result.message);
  }

  return { status: 200 as const, body: result.body };
});

const deploymentsInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(deploymentsParams$);
  const result = await set(
    getHostedSiteDeployments$,
    {
      orgId: auth.orgId,
      runId: "runId" in auth ? auth.runId : undefined,
      site: params.site,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "not_found") {
    return notFound(result.message);
  }
  return { status: 200 as const, body: result.body };
});

export const hostRoutes: readonly RouteEntry[] = [
  {
    route: hostContract.prepare,
    handler: authRoute(
      {
        requiredCapability: "host:write",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      prepareInner$,
    ),
  },
  {
    route: hostContract.complete,
    handler: authRoute(
      {
        requiredCapability: "host:write",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      completeInner$,
    ),
  },
  {
    route: hostContract.files,
    handler: authRoute(
      {
        requiredCapability: "host:read",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      filesInner$,
    ),
  },
  {
    route: hostContract.deployments,
    handler: authRoute(
      {
        requiredCapability: "host:read",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      deploymentsInner$,
    ),
  },
];
