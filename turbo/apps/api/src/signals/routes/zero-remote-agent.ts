import { command } from "ccstate";
import {
  zeroRemoteAgentDeviceClaimContract,
  zeroRemoteAgentDevicePollContract,
  zeroRemoteAgentDeviceStartContract,
  zeroRemoteAgentHostJobsContract,
  zeroRemoteAgentHostRealtimeContract,
  zeroRemoteAgentHeartbeatContract,
  zeroRemoteAgentHostsContract,
  zeroRemoteAgentRunContract,
} from "@vm0/api-contracts/contracts/zero-remote-agent";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  claimRemoteAgentDeviceCode$,
  claimNextRemoteAgentHostJob$,
  completeRemoteAgentHostJob$,
  createRemoteAgentDeviceCode$,
  createRemoteAgentHostRealtimeToken$,
  createRemoteAgentJob$,
  deleteRemoteAgentHost$,
  getRemoteAgentJob$,
  heartbeatRemoteAgentHost$,
  listRemoteAgentHosts$,
  pollRemoteAgentDeviceCode$,
  startRemoteAgentHost$,
} from "../services/zero-remote-agent.service";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import type { RouteEntry } from "../route";

const remoteAgentDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Remote agent is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const unauthorizedRemoteAgent = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Remote agent token required",
      code: "UNAUTHORIZED",
    }),
  }),
});

const invalidRemoteAgentToken = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Invalid remote agent token",
      code: "UNAUTHORIZED",
    }),
  }),
});

function isRemoteAgentEnabled(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly overrides: Record<string, boolean>;
}): boolean {
  return isFeatureEnabled(FeatureSwitchKey.RemoteAgent, {
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

const startBody$ = bodyResultOf(zeroRemoteAgentDeviceStartContract.start);
const startInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(startBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = await set(
    createRemoteAgentDeviceCode$,
    {
      hostName: bodyResult.data.hostName,
      supportedBackends: bodyResult.data.supportedBackends,
    },
    signal,
  );
  signal.throwIfAborted();

  return { status: 200 as const, body };
});

const pollBody$ = bodyResultOf(zeroRemoteAgentDevicePollContract.poll);
const pollInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(pollBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    pollRemoteAgentDeviceCode$,
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

const claimBody$ = bodyResultOf(zeroRemoteAgentDeviceClaimContract.claim);
const claimInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isRemoteAgentEnabled({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return remoteAgentDisabled;
  }

  const bodyResult = await get(claimBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    claimRemoteAgentDeviceCode$,
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

const heartbeatBody$ = bodyResultOf(zeroRemoteAgentHeartbeatContract.heartbeat);
const heartbeatInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(heartbeatBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const hostToken = parseBearerToken(get(authorization$));
  if (!hostToken) {
    return unauthorizedRemoteAgent;
  }

  const result = await set(
    heartbeatRemoteAgentHost$,
    {
      hostToken,
      hostName: bodyResult.data.hostName,
      supportedBackends: bodyResult.data.supportedBackends,
    },
    signal,
  );
  signal.throwIfAborted();

  if (!result) {
    return invalidRemoteAgentToken;
  }

  return { status: 200 as const, body: { ok: true as const, ...result } };
});

const hostRealtimeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const hostToken = parseBearerToken(get(authorization$));
    if (!hostToken) {
      return unauthorizedRemoteAgent;
    }

    const result = await set(
      createRemoteAgentHostRealtimeToken$,
      { hostToken },
      signal,
    );
    signal.throwIfAborted();

    if (!result) {
      return invalidRemoteAgentToken;
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
    !isRemoteAgentEnabled({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return remoteAgentDisabled;
  }

  const result = await set(
    listRemoteAgentHosts$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();

  return { status: 200 as const, body: result };
});

const hostsStartBody$ = bodyResultOf(zeroRemoteAgentHostsContract.start);
const hostsStartInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isRemoteAgentEnabled({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return remoteAgentDisabled;
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
    supportedBackends: bodyResult.data.supportedBackends,
    ...(bodyResult.data.hostId ? { hostId: bodyResult.data.hostId } : {}),
  };
  const result = await set(startRemoteAgentHost$, startParams, signal);
  signal.throwIfAborted();

  if (result.status === "not_found") {
    return notFound("Remote-agent host not found");
  }

  return {
    status: 200 as const,
    body: {
      hostId: result.hostId,
      hostToken: result.hostToken,
    },
  };
});

const hostsDeleteParams$ = pathParamsOf(zeroRemoteAgentHostsContract.delete);
const hostsDeleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isRemoteAgentEnabled({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return remoteAgentDisabled;
  }

  const params = get(hostsDeleteParams$);
  const result = await set(
    deleteRemoteAgentHost$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      hostId: params.hostId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "not_found") {
    return notFound("Remote-agent host not found");
  }

  return { status: 200 as const, body: { ok: true as const } };
});

const runCreateBody$ = bodyResultOf(zeroRemoteAgentRunContract.create);
const runCreateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isRemoteAgentEnabled({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return remoteAgentDisabled;
  }

  const bodyResult = await get(runCreateBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const jobParams = {
    orgId: auth.orgId,
    userId: auth.userId,
    prompt: bodyResult.data.prompt,
    ...(bodyResult.data.hostName ? { hostName: bodyResult.data.hostName } : {}),
  };
  const result = await set(createRemoteAgentJob$, jobParams, signal);
  signal.throwIfAborted();

  if (result.status === "no_host") {
    return notFound(
      "No linked remote-agent host found. Start one with `vm0 remote-agent start --name <name>`.",
    );
  }
  if (result.status === "host_not_found") {
    return notFound("Remote-agent host not found");
  }
  if (result.status === "host_ambiguous") {
    return conflict("Multiple remote-agent hosts have this name");
  }
  if (result.status === "host_closed") {
    return conflict(
      "No online remote-agent host. Start one with `vm0 remote-agent start --name <name>`.",
    );
  }

  return {
    status: 200 as const,
    body: {
      jobId: result.jobId,
      status: result.jobStatus,
    },
  };
});

const runGetParams$ = pathParamsOf(zeroRemoteAgentRunContract.get);
const runGetInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isRemoteAgentEnabled({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return remoteAgentDisabled;
  }

  const params = get(runGetParams$);
  const result = await set(
    getRemoteAgentJob$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      jobId: params.jobId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (!result) {
    return notFound("Remote-agent job not found");
  }

  return { status: 200 as const, body: result };
});

const hostJobNextBody$ = bodyResultOf(zeroRemoteAgentHostJobsContract.next);
const hostJobNextInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(hostJobNextBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const hostToken = parseBearerToken(get(authorization$));
  if (!hostToken) {
    return unauthorizedRemoteAgent;
  }

  const result = await set(
    claimNextRemoteAgentHostJob$,
    {
      hostToken,
      supportedBackends: bodyResult.data.supportedBackends,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "invalid_token") {
    return invalidRemoteAgentToken;
  }
  if (result.status === "idle") {
    return { status: 200 as const, body: { status: "idle" as const } };
  }

  return {
    status: 200 as const,
    body: { status: "job" as const, job: result.job },
  };
});

const hostJobCompleteBody$ = bodyResultOf(
  zeroRemoteAgentHostJobsContract.complete,
);
const hostJobCompleteParams$ = pathParamsOf(
  zeroRemoteAgentHostJobsContract.complete,
);
const hostJobCompleteInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(hostJobCompleteBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const hostToken = parseBearerToken(get(authorization$));
    if (!hostToken) {
      return unauthorizedRemoteAgent;
    }

    const params = get(hostJobCompleteParams$);
    const result = await set(
      completeRemoteAgentHostJob$,
      {
        hostToken,
        jobId: params.jobId,
        status: bodyResult.data.status,
        output: bodyResult.data.output,
        error: bodyResult.data.error,
        exitCode: bodyResult.data.exitCode,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "invalid_token") {
      return invalidRemoteAgentToken;
    }
    if (result.status === "not_found") {
      return notFound("Remote-agent job not found");
    }
    if (result.status === "not_running") {
      return conflict("Remote-agent job is not running");
    }

    return { status: 200 as const, body: { ok: true as const } };
  },
);

const remoteAgentAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const remoteAgentReadAuthOptions = {
  ...remoteAgentAuthOptions,
  requiredCapability: "remote-agent:read",
} as const;

const remoteAgentWriteAuthOptions = {
  ...remoteAgentAuthOptions,
  requiredCapability: "remote-agent:write",
} as const;

export const zeroRemoteAgentRoutes: readonly RouteEntry[] = [
  {
    route: zeroRemoteAgentDeviceStartContract.start,
    handler: startInner$,
  },
  {
    route: zeroRemoteAgentDevicePollContract.poll,
    handler: pollInner$,
  },
  {
    route: zeroRemoteAgentDeviceClaimContract.claim,
    handler: authRoute(remoteAgentAuthOptions, claimInner$),
  },
  {
    route: zeroRemoteAgentHeartbeatContract.heartbeat,
    handler: heartbeatInner$,
  },
  {
    route: zeroRemoteAgentHostRealtimeContract.create,
    handler: hostRealtimeInner$,
  },
  {
    route: zeroRemoteAgentHostsContract.start,
    handler: authRoute(remoteAgentAuthOptions, hostsStartInner$),
  },
  {
    route: zeroRemoteAgentHostsContract.list,
    handler: authRoute(remoteAgentReadAuthOptions, hostsListInner$),
  },
  {
    route: zeroRemoteAgentHostsContract.delete,
    handler: authRoute(remoteAgentAuthOptions, hostsDeleteInner$),
  },
  {
    route: zeroRemoteAgentRunContract.create,
    handler: authRoute(remoteAgentWriteAuthOptions, runCreateInner$),
  },
  {
    route: zeroRemoteAgentRunContract.get,
    handler: authRoute(remoteAgentReadAuthOptions, runGetInner$),
  },
  {
    route: zeroRemoteAgentHostJobsContract.next,
    handler: hostJobNextInner$,
  },
  {
    route: zeroRemoteAgentHostJobsContract.complete,
    handler: hostJobCompleteInner$,
  },
];
