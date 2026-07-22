import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { zeroHostContract } from "@vm0/api-contracts/contracts/zero-host";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { isLlmConfigured } from "../external/openrouter";
import {
  completeHostedSiteDeployment$,
  createHtmlEditDraft$,
  generatePresentationSpeakerNotes$,
  getHostedSiteDeployments$,
  getHostedSiteFiles$,
  HTML_DOM_EDIT_MODEL,
  prepareHostedSiteDeployment$,
  redeployHtml$,
  redeployPresentationHtml$,
} from "../services/zero-host.service";
import { checkBillableOperationCredits$ } from "../services/billable-operation-admission.service";
import { checkOpenRouterUsagePricing$ } from "../services/openrouter-usage.service";
import { rejectSuspendedOrg$ } from "../services/zero-org-suspension.service";
import {
  badRequestMessage,
  conflict,
  insufficientCredits,
  notFound,
  notConfigured,
} from "../../lib/error";
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

  const result = await set(
    prepareHostedSiteDeployment$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      runId: "runId" in auth ? auth.runId : undefined,
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
const redeployPresentationHtmlBody$ = bodyResultOf(
  zeroHostContract.redeployPresentationHtml,
);
const redeployHtmlBody$ = bodyResultOf(zeroHostContract.redeployHtml);
const generateSpeakerNotesBody$ = bodyResultOf(
  zeroHostContract.generatePresentationSpeakerNotes,
);
const createHtmlEditDraftBody$ = bodyResultOf(
  zeroHostContract.createHtmlEditDraft,
);
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
  if (
    !isFeatureEnabled(FeatureSwitchKey.HostedArtifactVersions, {
      orgId: auth.orgId,
      userId: auth.userId,
    })
  ) {
    return forbidden("Hosted artifact versions are not enabled");
  }

  const params = get(deploymentsParams$);
  const result = await set(
    getHostedSiteDeployments$,
    { orgId: auth.orgId, site: params.site },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "not_found") {
    return notFound(result.message);
  }
  return { status: 200 as const, body: result.body };
});

const redeployPresentationHtmlInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);

    const bodyResult = await get(redeployPresentationHtmlBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
    if (suspended) {
      return suspended;
    }

    const result = await set(
      redeployPresentationHtml$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
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
    if (result.status === "not_found") {
      return notFound(result.message);
    }
    if (result.status === "config_error") {
      return internalError(result.message);
    }

    return { status: 200 as const, body: result.body };
  },
);

const redeployHtmlInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);

    const bodyResult = await get(redeployHtmlBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
    if (suspended) {
      return suspended;
    }

    const result = await set(
      redeployHtml$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
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
    if (result.status === "not_found") {
      return notFound(result.message);
    }
    if (result.status === "config_error") {
      return internalError(result.message);
    }

    return { status: 200 as const, body: result.body };
  },
);

const generateSpeakerNotesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);

    const bodyResult = await get(generateSpeakerNotesBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
    if (suspended) {
      return suspended;
    }

    const result = await set(
      generatePresentationSpeakerNotes$,
      { body: bodyResult.data },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "bad_request") {
      return badRequestMessage(result.message);
    }
    if (result.status === "config_error") {
      return internalError(result.message);
    }

    return { status: 200 as const, body: result.body };
  },
);

const createHtmlEditDraftInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);

    const bodyResult = await get(createHtmlEditDraftBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
    if (suspended) {
      return suspended;
    }

    if (isLlmConfigured()) {
      const hasCredits = await set(
        checkBillableOperationCredits$,
        { orgId: auth.orgId },
        signal,
      );
      signal.throwIfAborted();
      if (!hasCredits) {
        return insufficientCredits();
      }

      const missingPricing = await set(
        checkOpenRouterUsagePricing$,
        { provider: HTML_DOM_EDIT_MODEL },
        signal,
      );
      signal.throwIfAborted();
      if (missingPricing.length > 0) {
        return notConfigured("HTML edit pricing is not configured");
      }
    }

    const operationId = randomUUID();
    const result = await set(
      createHtmlEditDraft$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        runId: "runId" in auth ? auth.runId : undefined,
        operationId,
        body: bodyResult.data,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "bad_request") {
      return badRequestMessage(result.message);
    }
    if (result.status === "config_error") {
      return internalError(result.message);
    }

    return { status: 200 as const, body: result.body };
  },
);

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
  {
    route: zeroHostContract.redeployPresentationHtml,
    handler: authRoute(
      {
        requiredCapability: "host:write",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      redeployPresentationHtmlInner$,
    ),
  },
  {
    route: zeroHostContract.redeployHtml,
    handler: authRoute(
      {
        requiredCapability: "host:write",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      redeployHtmlInner$,
    ),
  },
  {
    route: zeroHostContract.generatePresentationSpeakerNotes,
    handler: authRoute(
      {
        requiredCapability: "host:write",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      generateSpeakerNotesInner$,
    ),
  },
  {
    route: zeroHostContract.createHtmlEditDraft,
    handler: authRoute(
      {
        requiredCapability: "host:write",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      createHtmlEditDraftInner$,
    ),
  },
];
