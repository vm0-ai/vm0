import { command } from "ccstate";
import {
  zeroLocalBrowserDeviceClaimContract,
  zeroLocalBrowserDevicePollContract,
  zeroLocalBrowserDeviceStartContract,
  zeroLocalBrowserHeartbeatContract,
  zeroLocalBrowserHostRealtimeContract,
  zeroLocalBrowserAuditEventsContract,
  zeroLocalBrowserCommandContract,
  zeroLocalBrowserCommandApprovalContract,
  zeroLocalBrowserHostCommandsContract,
  zeroLocalBrowserHostsContract,
  zeroLocalBrowserHostSelfContract,
  zeroLocalBrowserWriteCommandContract,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  approveLocalBrowserWriteCommand$,
  claimLocalBrowserDeviceCode$,
  claimNextLocalBrowserHostCommand$,
  completeLocalBrowserHostCommand$,
  createLocalBrowserDeviceCode$,
  createLocalBrowserReadCommand$,
  createLocalBrowserWriteCommand$,
  createLocalBrowserHostRealtimeToken$,
  deleteLocalBrowserHost$,
  getLocalBrowserReadCommand$,
  heartbeatLocalBrowserHost$,
  listLocalBrowserAuditEvents$,
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

const missingLocalBrowserCommandCapability = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message:
        "Missing required capability: local-browser:read or local-browser:write",
      code: "FORBIDDEN",
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

const auditEventsListQuery$ = queryOf(zeroLocalBrowserAuditEventsContract.list);
const auditEventsListInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
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

    const query = get(auditEventsListQuery$);
    const result = await set(
      listLocalBrowserAuditEvents$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        limit: query.limit,
        ...(query.commandId ? { commandId: query.commandId } : {}),
        ...(query.hostId ? { hostId: query.hostId } : {}),
        ...(query.runId ? { runId: query.runId } : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    return { status: 200 as const, body: result };
  },
);

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

const commandCreateBody$ = bodyResultOf(zeroLocalBrowserCommandContract.create);
const commandCreateInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
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

    const bodyResult = await get(commandCreateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const commandParams = {
      orgId: auth.orgId,
      userId: auth.userId,
      kind: bodyResult.data.kind,
      timeoutMs: bodyResult.data.timeoutMs,
      ...(auth.tokenType === "zero" ? { runId: auth.runId } : {}),
      ...(bodyResult.data.tabId ? { tabId: bodyResult.data.tabId } : {}),
      ...(bodyResult.data.hostId ? { hostId: bodyResult.data.hostId } : {}),
      ...(bodyResult.data.hostName
        ? { hostName: bodyResult.data.hostName }
        : {}),
    };
    const result = await set(
      createLocalBrowserReadCommand$,
      commandParams,
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "no_connector") {
      return conflict(
        "Connect the local-browser connector before reading tabs",
      );
    }
    if (result.status === "no_host") {
      return notFound("No linked local-browser host found");
    }
    if (result.status === "host_not_found") {
      return notFound("Local-browser host not found");
    }
    if (result.status === "host_ambiguous") {
      return conflict("Multiple local-browser hosts have this name");
    }
    if (result.status === "host_offline") {
      return conflict("No online local-browser host found");
    }
    if (result.status === "host_unsupported") {
      return conflict("No online local-browser host supports this command");
    }

    return {
      status: 200 as const,
      body: {
        commandId: result.commandId,
        status: result.commandStatus,
      },
    };
  },
);

const writeCommandCreateBody$ = bodyResultOf(
  zeroLocalBrowserWriteCommandContract.create,
);
const writeCommandCreateInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
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

    const bodyResult = await get(writeCommandCreateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const payload = {
      ...(bodyResult.data.tabId ? { tabId: bodyResult.data.tabId } : {}),
      ...(bodyResult.data.selector
        ? { selector: bodyResult.data.selector }
        : {}),
      ...(bodyResult.data.x !== undefined ? { x: bodyResult.data.x } : {}),
      ...(bodyResult.data.y !== undefined ? { y: bodyResult.data.y } : {}),
      ...(bodyResult.data.text ? { text: bodyResult.data.text } : {}),
      ...(bodyResult.data.direction
        ? { direction: bodyResult.data.direction }
        : {}),
      ...(bodyResult.data.amount !== undefined
        ? { amount: bodyResult.data.amount }
        : {}),
      ...(bodyResult.data.url ? { url: bodyResult.data.url } : {}),
    };
    const commandParams = {
      orgId: auth.orgId,
      userId: auth.userId,
      kind: bodyResult.data.kind,
      payload,
      timeoutMs: bodyResult.data.timeoutMs,
      ...(auth.tokenType === "zero" ? { runId: auth.runId } : {}),
      ...(bodyResult.data.hostId ? { hostId: bodyResult.data.hostId } : {}),
      ...(bodyResult.data.hostName
        ? { hostName: bodyResult.data.hostName }
        : {}),
    };
    const result = await set(
      createLocalBrowserWriteCommand$,
      commandParams,
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "no_connector") {
      return conflict(
        "Connect the local-browser connector before controlling tabs",
      );
    }
    if (result.status === "no_host") {
      return notFound("No linked local-browser host found");
    }
    if (result.status === "host_not_found") {
      return notFound("Local-browser host not found");
    }
    if (result.status === "host_ambiguous") {
      return conflict("Multiple local-browser hosts have this name");
    }
    if (result.status === "host_offline") {
      return conflict("No online local-browser host found");
    }
    if (result.status === "host_unsupported") {
      return conflict("No online local-browser host supports this command");
    }

    return {
      status: 200 as const,
      body: {
        commandId: result.commandId,
        status: result.commandStatus,
      },
    };
  },
);

const commandGetParams$ = pathParamsOf(zeroLocalBrowserCommandContract.get);
const commandGetInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (
    auth.tokenType === "sandbox" ||
    (auth.tokenType === "zero" &&
      !auth.capabilities.some((capability) => {
        return (
          capability === "local-browser:read" ||
          capability === "local-browser:write"
        );
      }))
  ) {
    return missingLocalBrowserCommandCapability;
  }

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

  const params = get(commandGetParams$);
  const result = await set(
    getLocalBrowserReadCommand$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      commandId: params.commandId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (!result) {
    return notFound("Local-browser command not found");
  }

  return { status: 200 as const, body: result };
});

const commandApprovalBody$ = bodyResultOf(
  zeroLocalBrowserCommandApprovalContract.decide,
);
const commandApprovalParams$ = pathParamsOf(
  zeroLocalBrowserCommandApprovalContract.decide,
);
const commandApprovalInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
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

    const bodyResult = await get(commandApprovalBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const params = get(commandApprovalParams$);
    const result = await set(
      approveLocalBrowserWriteCommand$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        commandId: params.commandId,
        decision: bodyResult.data.decision,
        ...(bodyResult.data.message
          ? { message: bodyResult.data.message }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "not_found") {
      return notFound("Local-browser write command not found");
    }
    if (result.status === "not_pending") {
      return conflict("Local-browser write command is not pending approval");
    }

    return {
      status: 200 as const,
      body: {
        commandId: result.commandId,
        status: result.status === "approved" ? "queued" : "failed",
      },
    };
  },
);

const hostCommandNextBody$ = bodyResultOf(
  zeroLocalBrowserHostCommandsContract.next,
);
const hostCommandNextInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(hostCommandNextBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const hostToken = parseBearerToken(get(authorization$));
    if (!hostToken) {
      return unauthorizedLocalBrowser;
    }

    const result = await set(
      claimNextLocalBrowserHostCommand$,
      {
        hostToken,
        supportedCapabilities: bodyResult.data.supportedCapabilities,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "invalid_token") {
      return invalidLocalBrowserToken;
    }
    if (result.status === "idle") {
      return { status: 200 as const, body: { status: "idle" as const } };
    }

    return {
      status: 200 as const,
      body: { status: "command" as const, command: result.command },
    };
  },
);

const hostCommandCompleteBody$ = bodyResultOf(
  zeroLocalBrowserHostCommandsContract.complete,
);
const hostCommandCompleteParams$ = pathParamsOf(
  zeroLocalBrowserHostCommandsContract.complete,
);
const hostCommandCompleteInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(hostCommandCompleteBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const hostToken = parseBearerToken(get(authorization$));
    if (!hostToken) {
      return unauthorizedLocalBrowser;
    }

    const params = get(hostCommandCompleteParams$);
    const commandResult =
      bodyResult.data.status === "succeeded"
        ? {
            hostToken,
            commandId: params.commandId,
            status: bodyResult.data.status,
            result: bodyResult.data.result,
          }
        : {
            hostToken,
            commandId: params.commandId,
            status: bodyResult.data.status,
            error: bodyResult.data.error,
          };
    const result = await set(
      completeLocalBrowserHostCommand$,
      commandResult,
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "invalid_token") {
      return invalidLocalBrowserToken;
    }
    if (result.status === "not_found") {
      return notFound("Local-browser command not found");
    }
    if (result.status === "not_running") {
      return conflict("Local-browser command is not running");
    }

    return { status: 200 as const, body: { ok: true as const } };
  },
);

const localBrowserAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const localBrowserReadAuthOptions = {
  ...localBrowserAuthOptions,
  requiredCapability: "local-browser:read",
} as const;

const localBrowserWriteAuthOptions = {
  ...localBrowserAuthOptions,
  requiredCapability: "local-browser:write",
} as const;

const localBrowserCommandGetAuthOptions = {
  ...localBrowserAuthOptions,
  acceptAnySandboxCapability: true,
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
    route: zeroLocalBrowserAuditEventsContract.list,
    handler: authRoute(localBrowserAuthOptions, auditEventsListInner$),
  },
  {
    route: zeroLocalBrowserHostsContract.delete,
    handler: authRoute(localBrowserAuthOptions, hostsDeleteInner$),
  },
  {
    route: zeroLocalBrowserHostSelfContract.delete,
    handler: hostSelfDeleteInner$,
  },
  {
    route: zeroLocalBrowserCommandContract.create,
    handler: authRoute(localBrowserReadAuthOptions, commandCreateInner$),
  },
  {
    route: zeroLocalBrowserWriteCommandContract.create,
    handler: authRoute(localBrowserWriteAuthOptions, writeCommandCreateInner$),
  },
  {
    route: zeroLocalBrowserCommandContract.get,
    handler: authRoute(localBrowserCommandGetAuthOptions, commandGetInner$),
  },
  {
    route: zeroLocalBrowserCommandApprovalContract.decide,
    handler: authRoute(localBrowserAuthOptions, commandApprovalInner$),
  },
  {
    route: zeroLocalBrowserHostCommandsContract.next,
    handler: hostCommandNextInner$,
  },
  {
    route: zeroLocalBrowserHostCommandsContract.complete,
    handler: hostCommandCompleteInner$,
  },
];
