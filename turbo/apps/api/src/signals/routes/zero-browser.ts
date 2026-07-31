import { zeroBrowserContract } from "@vm0/api-contracts/contracts/zero-browser";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  createZeroBrowser$,
  getCurrentZeroBrowser$,
  getZeroBrowser$,
  leaseCurrentZeroBrowser$,
  leaseZeroBrowserByThread$,
  resizeZeroBrowserByThread$,
  startZeroBrowserForThread$,
  stopZeroBrowserForThread$,
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

const leaseByThreadParams$ = pathParamsOf(zeroBrowserContract.leaseByThread);
const leaseByThreadBody$ = bodyResultOf(zeroBrowserContract.leaseByThread);
const leaseBrowserByThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(leaseByThreadBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      leaseZeroBrowserByThread$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        chatThreadId: get(leaseByThreadParams$).threadId,
        ...("runId" in auth ? { runId: auth.runId } : {}),
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
  },
);

const startParams$ = pathParamsOf(zeroBrowserContract.start);
const startBody$ = bodyResultOf(zeroBrowserContract.start);
const startBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(startBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      startZeroBrowserForThread$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        chatThreadId: get(startParams$).threadId,
        lifecycleEventId: body.data.eventId,
        ...("runId" in auth ? { runId: auth.runId } : {}),
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: result.value };
  },
);

const stopParams$ = pathParamsOf(zeroBrowserContract.stop);
const stopBody$ = bodyResultOf(zeroBrowserContract.stop);
const stopBrowserInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(stopBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  const result = await set(
    stopZeroBrowserForThread$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      chatThreadId: get(stopParams$).threadId,
      lifecycleEventId: body.data.eventId,
      ...("runId" in auth ? { runId: auth.runId } : {}),
    },
    signal,
  );
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: result.value };
});

const resizeByThreadParams$ = pathParamsOf(zeroBrowserContract.resizeByThread);
const resizeByThreadBody$ = bodyResultOf(zeroBrowserContract.resizeByThread);
const resizeBrowserByThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(resizeByThreadBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      resizeZeroBrowserByThread$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        chatThreadId: get(resizeByThreadParams$).threadId,
        aspectRatio: body.data.aspectRatio,
        ...("runId" in auth ? { runId: auth.runId } : {}),
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
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
const getBrowserInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const result = await set(
    getZeroBrowser$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      chatThreadId: get(getParams$).threadId,
      ...("runId" in auth ? { runId: auth.runId } : {}),
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
    route: zeroBrowserContract.lease,
    handler: authRoute(browserWriteAuth, leaseBrowserInner$),
  },
  {
    route: zeroBrowserContract.leaseByThread,
    handler: authRoute(browserViewerWriteAuth, leaseBrowserByThreadInner$),
  },
  {
    route: zeroBrowserContract.start,
    handler: authRoute(browserViewerWriteAuth, startBrowserInner$),
  },
  {
    route: zeroBrowserContract.stop,
    handler: authRoute(browserViewerWriteAuth, stopBrowserInner$),
  },
  {
    route: zeroBrowserContract.resizeByThread,
    handler: authRoute(browserViewerWriteAuth, resizeBrowserByThreadInner$),
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
