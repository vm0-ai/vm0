import { command } from "ccstate";
import {
  zeroComputerUseAuditEventsContract,
  zeroComputerUseCommandApprovalContract,
  zeroComputerUseCommandContract,
  zeroComputerUseHeartbeatContract,
  zeroComputerUseHostCommandsContract,
  zeroComputerUseHostsContract,
  zeroComputerUseWriteCommandContract,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  approveComputerUseWriteCommand$,
  claimNextComputerUseHostCommand$,
  completeComputerUseHostCommand$,
  createComputerUseCommand$,
  deleteComputerUseHost$,
  getComputerUseCommand$,
  heartbeatComputerUseHost$,
  listComputerUseAuditEvents$,
  listComputerUseHosts$,
  startComputerUseHost$,
  stopComputerUseHost$,
} from "../services/zero-computer-use.service";
import type { RouteEntry } from "../route";

const computerUseDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Computer use is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const invalidComputerUseToken = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Invalid computer-use host token",
      code: "UNAUTHORIZED",
    }),
  }),
});

const unauthorizedComputerUse = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Missing computer-use host token",
      code: "UNAUTHORIZED",
    }),
  }),
});

function notFound(message: string) {
  return {
    status: 404 as const,
    body: { error: { message, code: "NOT_FOUND" } },
  };
}

function conflict(message: string) {
  return {
    status: 409 as const,
    body: { error: { message, code: "CONFLICT" } },
  };
}

function parseBearerToken(authorization: string | undefined): string | null {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    return null;
  }
  const token = authorization.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
}

const computerUseEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.ComputerUse, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

const hostStartBody$ = bodyResultOf(zeroComputerUseHostsContract.start);
const hostStartInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(computerUseEnabled$))) {
    return computerUseDisabled;
  }
  signal.throwIfAborted();

  const bodyResult = await get(hostStartBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    startComputerUseHost$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "active_host_exists") {
    return conflict("A Desktop Computer Use host is already active");
  }
  return {
    status: 200 as const,
    body: { hostId: result.hostId, hostToken: result.hostToken },
  };
});

const heartbeatBody$ = bodyResultOf(zeroComputerUseHeartbeatContract.heartbeat);
const heartbeatInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(heartbeatBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const hostToken = parseBearerToken(get(authorization$));
  if (!hostToken) {
    return unauthorizedComputerUse;
  }

  const result = await set(
    heartbeatComputerUseHost$,
    { hostToken, ...bodyResult.data },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "invalid_token") {
    return invalidComputerUseToken;
  }
  if (result.status === "active_host_exists") {
    return conflict("A Desktop Computer Use host is already active");
  }
  return {
    status: 200 as const,
    body: { ok: true as const, hostId: result.hostId },
  };
});

const hostStopBody$ = bodyResultOf(zeroComputerUseHeartbeatContract.stop);
const hostStopInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(hostStopBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const hostToken = parseBearerToken(get(authorization$));
  if (!hostToken) {
    return unauthorizedComputerUse;
  }

  const result = await set(stopComputerUseHost$, { hostToken }, signal);
  signal.throwIfAborted();

  if (result.status === "invalid_token") {
    return invalidComputerUseToken;
  }
  return {
    status: 200 as const,
    body: { ok: true as const, hostId: result.hostId },
  };
});

const hostsListInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(computerUseEnabled$))) {
    return computerUseDisabled;
  }
  signal.throwIfAborted();

  const result = await set(
    listComputerUseHosts$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();

  return { status: 200 as const, body: result };
});

const hostDeleteParams$ = pathParamsOf(zeroComputerUseHostsContract.delete);
const hostDeleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(computerUseEnabled$))) {
    return computerUseDisabled;
  }
  signal.throwIfAborted();

  const params = get(hostDeleteParams$);
  const result = await set(
    deleteComputerUseHost$,
    { orgId: auth.orgId, userId: auth.userId, hostId: params.hostId },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "not_found") {
    return notFound("Computer-use host not found");
  }
  return { status: 200 as const, body: { ok: true as const } };
});

const commandCreateBody$ = bodyResultOf(zeroComputerUseCommandContract.create);
const commandCreateInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await set(computerUseEnabled$))) {
      return computerUseDisabled;
    }
    signal.throwIfAborted();

    const bodyResult = await get(commandCreateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      createComputerUseCommand$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        kind: bodyResult.data.kind,
        payload: bodyResult.data,
        timeoutMs: bodyResult.data.timeoutMs,
        requiresApproval: false,
        ...(auth.tokenType === "zero" ? { runId: auth.runId } : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "no_host") {
      return notFound("No linked computer-use host found");
    }
    if (result.status === "host_ambiguous") {
      return conflict("Multiple active computer-use hosts are online");
    }
    if (result.status === "host_offline") {
      return conflict("No online computer-use host found");
    }
    if (result.status === "host_unsupported") {
      return conflict("No online computer-use host supports this command");
    }

    return {
      status: 200 as const,
      body: { commandId: result.commandId, status: result.commandStatus },
    };
  },
);

const writeCommandCreateBody$ = bodyResultOf(
  zeroComputerUseWriteCommandContract.create,
);
const writeCommandCreateInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await set(computerUseEnabled$))) {
      return computerUseDisabled;
    }
    signal.throwIfAborted();

    const bodyResult = await get(writeCommandCreateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      createComputerUseCommand$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        kind: bodyResult.data.kind,
        payload: bodyResult.data,
        timeoutMs: bodyResult.data.timeoutMs,
        requiresApproval: false,
        ...(auth.tokenType === "zero" ? { runId: auth.runId } : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "no_host") {
      return notFound("No linked computer-use host found");
    }
    if (result.status === "host_ambiguous") {
      return conflict("Multiple active computer-use hosts are online");
    }
    if (result.status === "host_offline") {
      return conflict("No online computer-use host found");
    }
    if (result.status === "host_unsupported") {
      return conflict("No online computer-use host supports this command");
    }

    return {
      status: 200 as const,
      body: { commandId: result.commandId, status: result.commandStatus },
    };
  },
);

const commandGetParams$ = pathParamsOf(zeroComputerUseCommandContract.get);
const commandGetInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(computerUseEnabled$))) {
    return computerUseDisabled;
  }
  signal.throwIfAborted();

  const params = get(commandGetParams$);
  const result = await set(
    getComputerUseCommand$,
    { orgId: auth.orgId, userId: auth.userId, commandId: params.commandId },
    signal,
  );
  signal.throwIfAborted();

  if (!result) {
    return notFound("Computer-use command not found");
  }
  return { status: 200 as const, body: result };
});

const commandApprovalBody$ = bodyResultOf(
  zeroComputerUseCommandApprovalContract.decide,
);
const commandApprovalParams$ = pathParamsOf(
  zeroComputerUseCommandApprovalContract.decide,
);
const commandApprovalInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await set(computerUseEnabled$))) {
      return computerUseDisabled;
    }
    signal.throwIfAborted();

    const bodyResult = await get(commandApprovalBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const params = get(commandApprovalParams$);
    const result = await set(
      approveComputerUseWriteCommand$,
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
      return notFound("Computer-use write command not found");
    }
    if (result.status === "not_pending") {
      return conflict("Computer-use write command is not pending approval");
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
  zeroComputerUseHostCommandsContract.next,
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
      return unauthorizedComputerUse;
    }

    const result = await set(
      claimNextComputerUseHostCommand$,
      {
        hostToken,
        supportedCapabilities: bodyResult.data.supportedCapabilities,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "invalid_token") {
      return invalidComputerUseToken;
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
  zeroComputerUseHostCommandsContract.complete,
);
const hostCommandCompleteParams$ = pathParamsOf(
  zeroComputerUseHostCommandsContract.complete,
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
      return unauthorizedComputerUse;
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
      completeComputerUseHostCommand$,
      commandResult,
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "invalid_token") {
      return invalidComputerUseToken;
    }
    if (result.status === "not_found") {
      return notFound("Computer-use command not found");
    }
    if (result.status === "not_running") {
      return conflict("Computer-use command is not running");
    }

    return { status: 200 as const, body: { ok: true as const } };
  },
);

const auditEventsQuery$ = queryOf(zeroComputerUseAuditEventsContract.list);
const auditEventsListInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await set(computerUseEnabled$))) {
      return computerUseDisabled;
    }
    signal.throwIfAborted();

    const query = get(auditEventsQuery$);
    const result = await set(
      listComputerUseAuditEvents$,
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

const computerUseAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const computerUseCommandAuthOptions = {
  ...computerUseAuthOptions,
  requiredCapability: "computer-use:write",
} as const;

const computerUseSessionAuthOptions = {
  ...computerUseAuthOptions,
  accept: ["session"],
} as const;

export const zeroComputerUseRoutes: readonly RouteEntry[] = [
  {
    route: zeroComputerUseHostsContract.start,
    handler: authRoute(computerUseAuthOptions, hostStartInner$),
  },
  {
    route: zeroComputerUseHeartbeatContract.heartbeat,
    handler: heartbeatInner$,
  },
  {
    route: zeroComputerUseHeartbeatContract.stop,
    handler: hostStopInner$,
  },
  {
    route: zeroComputerUseHostsContract.list,
    handler: authRoute(computerUseAuthOptions, hostsListInner$),
  },
  {
    route: zeroComputerUseHostsContract.delete,
    handler: authRoute(computerUseAuthOptions, hostDeleteInner$),
  },
  {
    route: zeroComputerUseCommandContract.create,
    handler: authRoute(computerUseCommandAuthOptions, commandCreateInner$),
  },
  {
    route: zeroComputerUseWriteCommandContract.create,
    handler: authRoute(computerUseCommandAuthOptions, writeCommandCreateInner$),
  },
  {
    route: zeroComputerUseCommandContract.get,
    handler: authRoute(computerUseCommandAuthOptions, commandGetInner$),
  },
  {
    route: zeroComputerUseCommandApprovalContract.decide,
    handler: authRoute(computerUseSessionAuthOptions, commandApprovalInner$),
  },
  {
    route: zeroComputerUseHostCommandsContract.next,
    handler: hostCommandNextInner$,
  },
  {
    route: zeroComputerUseHostCommandsContract.complete,
    handler: hostCommandCompleteInner$,
  },
  {
    route: zeroComputerUseAuditEventsContract.list,
    handler: authRoute(computerUseAuthOptions, auditEventsListInner$),
  },
];
