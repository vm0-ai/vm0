import { command } from "ccstate";
import {
  zeroLocalAgentDeviceClaimContract,
  zeroLocalAgentDevicePollContract,
  zeroLocalAgentDeviceStartContract,
  zeroLocalAgentHostJobsContract,
  zeroLocalAgentHostRealtimeContract,
  zeroLocalAgentHeartbeatContract,
  zeroLocalAgentHostsContract,
  zeroLocalAgentRunContract,
} from "@vm0/api-contracts/contracts/zero-local-agent";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import {
  claimLocalAgentDeviceCode$,
  claimNextLocalAgentHostJob$,
  completeLocalAgentHostJob$,
  createLocalAgentDeviceCode$,
  createLocalAgentHostRealtimeToken$,
  createLocalAgentJob$,
  deleteLocalAgentHost$,
  getLocalAgentJob$,
  heartbeatLocalAgentHost$,
  listLocalAgentJobs$,
  listLocalAgentHosts$,
  pollLocalAgentDeviceCode$,
  startLocalAgentHost$,
} from "../services/zero-local-agent.service";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import type { RouteEntry } from "../route";

const unauthorizedLocalAgent = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Local agent token required",
      code: "UNAUTHORIZED",
    }),
  }),
});

const invalidLocalAgentToken = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Invalid local agent token",
      code: "UNAUTHORIZED",
    }),
  }),
});

function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.substring("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

const startBody$ = bodyResultOf(zeroLocalAgentDeviceStartContract.start);
const startInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(startBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = await set(
    createLocalAgentDeviceCode$,
    {
      hostName: bodyResult.data.hostName,
      supportedBackends: bodyResult.data.supportedBackends,
    },
    signal,
  );
  signal.throwIfAborted();

  return { status: 200 as const, body };
});

const pollBody$ = bodyResultOf(zeroLocalAgentDevicePollContract.poll);
const pollInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(pollBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    pollLocalAgentDeviceCode$,
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

const claimBody$ = bodyResultOf(zeroLocalAgentDeviceClaimContract.claim);
const claimInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const bodyResult = await get(claimBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    claimLocalAgentDeviceCode$,
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

const heartbeatBody$ = bodyResultOf(zeroLocalAgentHeartbeatContract.heartbeat);
const heartbeatInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(heartbeatBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const hostToken = parseBearerToken(get(authorization$));
  if (!hostToken) {
    return unauthorizedLocalAgent;
  }

  const result = await set(
    heartbeatLocalAgentHost$,
    {
      hostToken,
      hostName: bodyResult.data.hostName,
      supportedBackends: bodyResult.data.supportedBackends,
    },
    signal,
  );
  signal.throwIfAborted();

  if (!result) {
    return invalidLocalAgentToken;
  }

  return { status: 200 as const, body: { ok: true as const, ...result } };
});

const hostRealtimeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const hostToken = parseBearerToken(get(authorization$));
    if (!hostToken) {
      return unauthorizedLocalAgent;
    }

    const result = await set(
      createLocalAgentHostRealtimeToken$,
      { hostToken },
      signal,
    );
    signal.throwIfAborted();

    if (!result) {
      return invalidLocalAgentToken;
    }

    return { status: 200 as const, body: result };
  },
);

const hostsListInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const result = await set(
    listLocalAgentHosts$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();

  return { status: 200 as const, body: result };
});

const hostsStartBody$ = bodyResultOf(zeroLocalAgentHostsContract.start);
const hostsStartInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

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
  const result = await set(startLocalAgentHost$, startParams, signal);
  signal.throwIfAborted();

  if (result.status === "not_found") {
    return notFound("Local-agent host not found");
  }

  return {
    status: 200 as const,
    body: {
      hostId: result.hostId,
      hostToken: result.hostToken,
    },
  };
});

const hostsDeleteParams$ = pathParamsOf(zeroLocalAgentHostsContract.delete);
const hostsDeleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const params = get(hostsDeleteParams$);
  const result = await set(
    deleteLocalAgentHost$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      hostId: params.hostId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "not_found") {
    return notFound("Local-agent host not found");
  }

  return { status: 200 as const, body: { ok: true as const } };
});

const runListQuery$ = queryOf(zeroLocalAgentRunContract.list);
const runListInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const query = get(runListQuery$);
  const result = await set(
    listLocalAgentJobs$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      status: query.status,
      hostId: query.hostId,
      hostName: query.hostName,
      limit: query.limit,
    },
    signal,
  );
  signal.throwIfAborted();

  return { status: 200 as const, body: result };
});

const runCreateBody$ = bodyResultOf(zeroLocalAgentRunContract.create);
const runCreateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

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
  const result = await set(createLocalAgentJob$, jobParams, signal);
  signal.throwIfAborted();

  if (result.status === "no_host") {
    return notFound(
      "No linked local-agent host found. Start one with `vm0 local-agent start --name <name>`.",
    );
  }
  if (result.status === "host_not_found") {
    return notFound("Local-agent host not found");
  }
  if (result.status === "host_ambiguous") {
    return conflict("Multiple local-agent hosts have this name");
  }
  if (result.status === "host_closed") {
    return conflict(
      "No online local-agent host. Start one with `vm0 local-agent start --name <name>`.",
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

const runGetParams$ = pathParamsOf(zeroLocalAgentRunContract.get);
const runGetInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const params = get(runGetParams$);
  const result = await set(
    getLocalAgentJob$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      jobId: params.jobId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (!result) {
    return notFound("Local-agent job not found");
  }

  return { status: 200 as const, body: result };
});

const hostJobNextBody$ = bodyResultOf(zeroLocalAgentHostJobsContract.next);
const hostJobNextInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(hostJobNextBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const hostToken = parseBearerToken(get(authorization$));
  if (!hostToken) {
    return unauthorizedLocalAgent;
  }

  const result = await set(
    claimNextLocalAgentHostJob$,
    {
      hostToken,
      supportedBackends: bodyResult.data.supportedBackends,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "invalid_token") {
    return invalidLocalAgentToken;
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
  zeroLocalAgentHostJobsContract.complete,
);
const hostJobCompleteParams$ = pathParamsOf(
  zeroLocalAgentHostJobsContract.complete,
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
      return unauthorizedLocalAgent;
    }

    const params = get(hostJobCompleteParams$);
    const result = await set(
      completeLocalAgentHostJob$,
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
      return invalidLocalAgentToken;
    }
    if (result.status === "not_found") {
      return notFound("Local-agent job not found");
    }
    if (result.status === "not_running") {
      return conflict("Local-agent job is not running");
    }

    return { status: 200 as const, body: { ok: true as const } };
  },
);

const localAgentAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const localAgentReadAuthOptions = {
  ...localAgentAuthOptions,
  requiredCapability: "local-agent:read",
} as const;

const localAgentWriteAuthOptions = {
  ...localAgentAuthOptions,
  requiredCapability: "local-agent:write",
} as const;

export const zeroLocalAgentRoutes: readonly RouteEntry[] = [
  {
    route: zeroLocalAgentDeviceStartContract.start,
    handler: startInner$,
  },
  {
    route: zeroLocalAgentDevicePollContract.poll,
    handler: pollInner$,
  },
  {
    route: zeroLocalAgentDeviceClaimContract.claim,
    handler: authRoute(localAgentAuthOptions, claimInner$),
  },
  {
    route: zeroLocalAgentHeartbeatContract.heartbeat,
    handler: heartbeatInner$,
  },
  {
    route: zeroLocalAgentHostRealtimeContract.create,
    handler: hostRealtimeInner$,
  },
  {
    route: zeroLocalAgentHostsContract.start,
    handler: authRoute(localAgentAuthOptions, hostsStartInner$),
  },
  {
    route: zeroLocalAgentHostsContract.list,
    handler: authRoute(localAgentReadAuthOptions, hostsListInner$),
  },
  {
    route: zeroLocalAgentHostsContract.delete,
    handler: authRoute(localAgentAuthOptions, hostsDeleteInner$),
  },
  {
    route: zeroLocalAgentRunContract.list,
    handler: authRoute(localAgentReadAuthOptions, runListInner$),
  },
  {
    route: zeroLocalAgentRunContract.create,
    handler: authRoute(localAgentWriteAuthOptions, runCreateInner$),
  },
  {
    route: zeroLocalAgentRunContract.get,
    handler: authRoute(localAgentReadAuthOptions, runGetInner$),
  },
  {
    route: zeroLocalAgentHostJobsContract.next,
    handler: hostJobNextInner$,
  },
  {
    route: zeroLocalAgentHostJobsContract.complete,
    handler: hostJobCompleteInner$,
  },
];
