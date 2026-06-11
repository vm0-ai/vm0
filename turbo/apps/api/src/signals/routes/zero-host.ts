import { command } from "ccstate";
import { zeroHostContract } from "@vm0/api-contracts/contracts/zero-host";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  completeHostedSiteDeployment$,
  generatePresentationSpeakerNotes$,
  getHostedSiteFiles$,
  prepareHostedSiteDeployment$,
  redeployPresentationHtml$,
} from "../services/zero-host.service";
import { rejectSuspendedOrg$ } from "../services/zero-org-suspension.service";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import type { RouteEntry } from "../route";

function internalError(message: string) {
  return {
    status: 500 as const,
    body: {
      error: { message, code: "INTERNAL_SERVER_ERROR" },
    },
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
const redeployPresentationHtmlBody$ = bodyResultOf(
  zeroHostContract.redeployPresentationHtml,
);
const generateSpeakerNotesBody$ = bodyResultOf(
  zeroHostContract.generatePresentationSpeakerNotes,
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

  const result = await set(
    getHostedSiteFiles$,
    {
      orgId: auth.orgId,
      publicSlug: params.publicSlug,
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
];
