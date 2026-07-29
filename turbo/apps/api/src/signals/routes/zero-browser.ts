import { zeroBrowserContract } from "@vm0/api-contracts/contracts/zero-browser";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  createZeroBrowser$,
  getCurrentZeroBrowser$,
  getZeroBrowser$,
  leaseCurrentZeroBrowser$,
  leaseZeroBrowserById$,
  resizeZeroBrowserById$,
  resumeZeroBrowserFromViewer$,
  useZeroBrowser$,
  type BrowserServiceError,
} from "../services/zero-browser.service";

function errorResponse(error: BrowserServiceError) {
  return {
    status: error.status,
    body: {
      error: {
        message: error.message,
        code: error.code,
      },
    },
  };
}

const createBody$ = bodyResultOf(zeroBrowserContract.create);
const createBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(createBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      createZeroBrowser$,
      {
        actor: {
          orgId: auth.orgId,
          userId: auth.userId,
          ...("runId" in auth ? { runId: auth.runId } : {}),
        },
        input: body.data,
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 201 as const, body: result.value };
  },
);

const useBody$ = bodyResultOf(zeroBrowserContract.use);
const useBrowserInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(useBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  const result = await set(
    useZeroBrowser$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...("runId" in auth ? { runId: auth.runId } : {}),
    },
    signal,
  );
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: result.value };
});

const leaseBody$ = bodyResultOf(zeroBrowserContract.lease);
const leaseBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(leaseBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      leaseCurrentZeroBrowser$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...("runId" in auth ? { runId: auth.runId } : {}),
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
  },
);

const leaseByIdParams$ = pathParamsOf(zeroBrowserContract.leaseById);
const leaseByIdBody$ = bodyResultOf(zeroBrowserContract.leaseById);
const leaseBrowserByIdInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(leaseByIdBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      leaseZeroBrowserById$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        browserId: get(leaseByIdParams$).browserId,
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
  },
);

const resumeByIdParams$ = pathParamsOf(zeroBrowserContract.resumeById);
const resumeByIdBody$ = bodyResultOf(zeroBrowserContract.resumeById);
const resumeBrowserByIdInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(resumeByIdBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      resumeZeroBrowserFromViewer$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        browserId: get(resumeByIdParams$).browserId,
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
  },
);

const resizeByIdParams$ = pathParamsOf(zeroBrowserContract.resizeById);
const resizeByIdBody$ = bodyResultOf(zeroBrowserContract.resizeById);
const resizeBrowserByIdInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(resizeByIdBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      resizeZeroBrowserById$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        browserId: get(resizeByIdParams$).browserId,
        aspectRatio: body.data.aspectRatio,
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: result.value };
  },
);

const currentBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const result = await set(
      getCurrentZeroBrowser$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...("runId" in auth ? { runId: auth.runId } : {}),
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
  },
);

const getParams$ = pathParamsOf(zeroBrowserContract.get);
const getQuery$ = queryOf(zeroBrowserContract.get);
const getBrowserInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const result = await set(
    getZeroBrowser$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      browserId: get(getParams$).browserId,
      chatThreadId: get(getQuery$).chatThreadId,
    },
    signal,
  );
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: { browser: result.value } };
});

const browserReadAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "browser:read" as const,
  accept: Object.freeze(["session", "zero"] as const),
});

const browserWriteAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "browser:write" as const,
  accept: Object.freeze(["zero"] as const),
});

// Keeping a browser alive and restarting a suspended one are viewer actions, so
// the signed-in owner may call them without a live run.
const browserViewerWriteAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "browser:write" as const,
  accept: Object.freeze(["session", "zero"] as const),
});

const browserCurrentAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "browser:read" as const,
  accept: Object.freeze(["zero"] as const),
});

export const zeroBrowserRoutes: readonly RouteEntry[] = [
  {
    route: zeroBrowserContract.create,
    handler: authRoute(browserWriteAuth, createBrowserInner$),
  },
  {
    route: zeroBrowserContract.use,
    handler: authRoute(browserWriteAuth, useBrowserInner$),
  },
  {
    route: zeroBrowserContract.resume,
    handler: authRoute(browserWriteAuth, useBrowserInner$),
  },
  {
    route: zeroBrowserContract.lease,
    handler: authRoute(browserWriteAuth, leaseBrowserInner$),
  },
  {
    route: zeroBrowserContract.leaseById,
    handler: authRoute(browserViewerWriteAuth, leaseBrowserByIdInner$),
  },
  {
    route: zeroBrowserContract.resumeById,
    handler: authRoute(browserViewerWriteAuth, resumeBrowserByIdInner$),
  },
  {
    route: zeroBrowserContract.resizeById,
    handler: authRoute(browserViewerWriteAuth, resizeBrowserByIdInner$),
  },
  {
    route: zeroBrowserContract.current,
    handler: authRoute(browserCurrentAuth, currentBrowserInner$),
  },
  {
    route: zeroBrowserContract.get,
    handler: authRoute(browserReadAuth, getBrowserInner$),
  },
];
