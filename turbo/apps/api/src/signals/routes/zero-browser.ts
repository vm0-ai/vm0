import { zeroBrowserContract } from "@vm0/api-contracts/contracts/zero-browser";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import {
  createZeroBrowser$,
  getCurrentZeroBrowser$,
  getZeroBrowser$,
  resumeZeroBrowser$,
  type BrowserServiceError,
} from "../services/zero-browser.service";

const browserFeatureDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Managed browsers are not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const browserFeatureEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType === "zero") {
    return true;
  }
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.ZeroBrowser, context);
});

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
    if (!(await set(browserFeatureEnabled$))) {
      return browserFeatureDisabled;
    }
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

const resumeBody$ = bodyResultOf(zeroBrowserContract.resume);
const resumeBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await set(browserFeatureEnabled$))) {
      return browserFeatureDisabled;
    }
    const body = await get(resumeBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      resumeZeroBrowser$,
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
  },
);

const currentBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await set(browserFeatureEnabled$))) {
      return browserFeatureDisabled;
    }
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
  if (!(await set(browserFeatureEnabled$))) {
    return browserFeatureDisabled;
  }
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
    route: zeroBrowserContract.resume,
    handler: authRoute(browserWriteAuth, resumeBrowserInner$),
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
