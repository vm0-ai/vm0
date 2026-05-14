import { command } from "ccstate";
import {
  zeroLocalBrowserDeviceClaimContract,
  zeroLocalBrowserDevicePollContract,
  zeroLocalBrowserDeviceStartContract,
  zeroLocalBrowserHeartbeatContract,
  zeroLocalBrowserHostRealtimeContract,
  zeroLocalBrowserHostsContract,
  zeroLocalBrowserHostSelfContract,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  claimLocalBrowserDeviceCode$,
  createLocalBrowserDeviceCode$,
  createLocalBrowserHostRealtimeToken$,
  deleteLocalBrowserHost$,
  heartbeatLocalBrowserHost$,
  listLocalBrowserHosts$,
  pollLocalBrowserDeviceCode$,
  revokeLocalBrowserHostToken$,
  startLocalBrowserHost$,
} from "../services/zero-local-browser.service";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import type { RouteEntry } from "../route";

const localBrowserDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Local browser use is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const unauthorizedLocalBrowser = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Local browser host token required",
      code: "UNAUTHORIZED",
    }),
  }),
});

const invalidLocalBrowserToken = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Invalid local browser host token",
      code: "UNAUTHORIZED",
    }),
  }),
});

function isLocalBrowserEnabled(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly overrides: Record<string, boolean>;
}): boolean {
  return isFeatureEnabled(FeatureSwitchKey.LocalBrowserUse, {
    orgId: params.orgId,
    userId: params.userId,
    overrides: params.overrides,
  });
}

function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.substring("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

const deviceStartBody$ = bodyResultOf(
  zeroLocalBrowserDeviceStartContract.start,
);
const deviceStartInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(deviceStartBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = await set(
    createLocalBrowserDeviceCode$,
    {
      hostName: bodyResult.data.hostName,
      browser: bodyResult.data.browser,
      extensionVersion: bodyResult.data.extensionVersion,
      supportedCapabilities: bodyResult.data.supportedCapabilities,
    },
    signal,
  );
  signal.throwIfAborted();

  return { status: 200 as const, body };
});

const devicePollBody$ = bodyResultOf(zeroLocalBrowserDevicePollContract.poll);
const devicePollInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(devicePollBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    pollLocalBrowserDeviceCode$,
    {
      deviceCode: bodyResult.data.deviceCode,
      pollToken: bodyResult.data.pollToken,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "invalid") {
    return badRequestMessage("Invalid device code");
  }

  return { status: 200 as const, body: result };
});

const deviceClaimBody$ = bodyResultOf(
  zeroLocalBrowserDeviceClaimContract.claim,
);
const deviceClaimInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isLocalBrowserEnabled({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return localBrowserDisabled;
  }

  const bodyResult = await get(deviceClaimBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    claimLocalBrowserDeviceCode$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      deviceCode: bodyResult.data.deviceCode,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "not_found") {
    return notFound("Device code not found");
  }
  if (result.status === "expired") {
    return badRequestMessage("Device code expired");
  }
  if (result.status === "already_claimed") {
    return conflict("Device code already claimed");
  }

  return { status: 200 as const, body: result };
});

const heartbeatBody$ = bodyResultOf(
  zeroLocalBrowserHeartbeatContract.heartbeat,
);
const heartbeatInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(heartbeatBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const hostToken = parseBearerToken(get(authorization$));
  if (!hostToken) {
    return unauthorizedLocalBrowser;
  }

  const result = await set(
    heartbeatLocalBrowserHost$,
    {
      hostToken,
      hostName: bodyResult.data.hostName,
      browser: bodyResult.data.browser,
      extensionVersion: bodyResult.data.extensionVersion,
      supportedCapabilities: bodyResult.data.supportedCapabilities,
    },
    signal,
  );
  signal.throwIfAborted();

  if (!result) {
    return invalidLocalBrowserToken;
  }

  return { status: 200 as const, body: { ok: true as const, ...result } };
});

const hostRealtimeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const hostToken = parseBearerToken(get(authorization$));
    if (!hostToken) {
      return unauthorizedLocalBrowser;
    }

    const result = await set(
      createLocalBrowserHostRealtimeToken$,
      { hostToken },
      signal,
    );
    signal.throwIfAborted();

    if (!result) {
      return invalidLocalBrowserToken;
    }

    return { status: 200 as const, body: result };
  },
);

const hostsListInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isLocalBrowserEnabled({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return localBrowserDisabled;
  }

  const result = await set(
    listLocalBrowserHosts$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();

  return { status: 200 as const, body: result };
});

const hostsStartBody$ = bodyResultOf(zeroLocalBrowserHostsContract.start);
const hostsStartInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isLocalBrowserEnabled({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return localBrowserDisabled;
  }

  const bodyResult = await get(hostsStartBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const startParams = {
    orgId: auth.orgId,
    userId: auth.userId,
    hostName: bodyResult.data.hostName,
    browser: bodyResult.data.browser,
    extensionVersion: bodyResult.data.extensionVersion,
    supportedCapabilities: bodyResult.data.supportedCapabilities,
    ...(bodyResult.data.hostId ? { hostId: bodyResult.data.hostId } : {}),
  };
  const result = await set(startLocalBrowserHost$, startParams, signal);
  signal.throwIfAborted();

  if (result.status === "not_found") {
    return notFound("Local-browser host not found");
  }

  return {
    status: 200 as const,
    body: {
      hostId: result.hostId,
      hostToken: result.hostToken,
    },
  };
});

const hostsDeleteParams$ = pathParamsOf(zeroLocalBrowserHostsContract.delete);
const hostsDeleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isLocalBrowserEnabled({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return localBrowserDisabled;
  }

  const params = get(hostsDeleteParams$);
  const result = await set(
    deleteLocalBrowserHost$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      hostId: params.hostId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "not_found") {
    return notFound("Local-browser host not found");
  }

  return { status: 200 as const, body: { ok: true as const } };
});

const hostSelfDeleteInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const hostToken = parseBearerToken(get(authorization$));
    if (!hostToken) {
      return unauthorizedLocalBrowser;
    }

    const result = await set(
      revokeLocalBrowserHostToken$,
      { hostToken },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "invalid_token") {
      return invalidLocalBrowserToken;
    }

    return { status: 200 as const, body: { ok: true as const } };
  },
);

const localBrowserAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const zeroLocalBrowserRoutes: readonly RouteEntry[] = [
  {
    route: zeroLocalBrowserDeviceStartContract.start,
    handler: deviceStartInner$,
  },
  {
    route: zeroLocalBrowserDevicePollContract.poll,
    handler: devicePollInner$,
  },
  {
    route: zeroLocalBrowserDeviceClaimContract.claim,
    handler: authRoute(localBrowserAuthOptions, deviceClaimInner$),
  },
  {
    route: zeroLocalBrowserHeartbeatContract.heartbeat,
    handler: heartbeatInner$,
  },
  {
    route: zeroLocalBrowserHostRealtimeContract.create,
    handler: hostRealtimeInner$,
  },
  {
    route: zeroLocalBrowserHostsContract.start,
    handler: authRoute(localBrowserAuthOptions, hostsStartInner$),
  },
  {
    route: zeroLocalBrowserHostsContract.list,
    handler: authRoute(localBrowserAuthOptions, hostsListInner$),
  },
  {
    route: zeroLocalBrowserHostsContract.delete,
    handler: authRoute(localBrowserAuthOptions, hostsDeleteInner$),
  },
  {
    route: zeroLocalBrowserHostSelfContract.delete,
    handler: hostSelfDeleteInner$,
  },
];
