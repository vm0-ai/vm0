import { command, computed } from "ccstate";
import { zeroHostContract } from "@vm0/api-contracts/contracts/zero-host";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import {
  completeHostedSiteDeployment$,
  getHostedSiteDeployments$,
  getHostedSiteFiles$,
  prepareHostedSiteDeployment$,
} from "../services/zero-host.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { rejectSuspendedOrg$ } from "../services/zero-org-suspension.service";
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

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" } },
  };
}

const hostedArtifactVersionsEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.HostedArtifactVersions, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

const prepareBody$ = bodyResultOf(zeroHostContract.prepare);
const prepareInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const bodyResult = await get(prepareBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
  if (suspended) {
    return suspended;
  }

  const versionedArtifactsEnabled = await get(hostedArtifactVersionsEnabled$);
  signal.throwIfAborted();

  const result = await set(
    prepareHostedSiteDeployment$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      runId: "runId" in auth ? auth.runId : undefined,
      versionedArtifactsEnabled,
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

const completeParams$ = pathParamsOf(zeroHostContract.complete);
const filesParams$ = pathParamsOf(zeroHostContract.files);
const filesQuery$ = queryOf(zeroHostContract.files);
const deploymentsParams$ = pathParamsOf(zeroHostContract.deployments);
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
  if (!(await get(hostedArtifactVersionsEnabled$))) {
    return forbidden("Hosted artifact versions are not enabled");
  }
  signal.throwIfAborted();

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

export const zeroHostRoutes: readonly RouteEntry[] = [
  {
    route: zeroHostContract.prepare,
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
    route: zeroHostContract.complete,
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
    route: zeroHostContract.files,
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
    route: zeroHostContract.deployments,
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
