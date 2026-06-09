import { command, computed } from "ccstate";
import {
  automationRunContract,
  automationsByNameContract,
  automationsEnableContract,
  automationsMainContract,
  type AutomationListResponse,
  type AutomationMutationResponse,
  type AutomationResponse,
} from "@vm0/api-contracts/contracts/automations";
import type {
  ScheduleListResponse,
  ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  deleteSchedule$,
  deploySchedule$,
  disableSchedule$,
  enableSchedule$,
  runScheduleNow$,
  zeroScheduleList,
} from "../services/zero-schedules.service";
import { now } from "../external/time";
import type { RouteEntry } from "../route";

// The Automations surface and the legacy schedule surface share the same
// service and the same cleaned field set, so a schedule projection IS the
// automation projection — only the wrapper key differs.
function toAutomation(schedule: ScheduleResponse): AutomationResponse {
  return schedule;
}

function toAutomationList(list: ScheduleListResponse): AutomationListResponse {
  return { automations: list.schedules.map(toAutomation) };
}

function toAutomationMutation(response: {
  readonly schedule: ScheduleResponse;
  readonly created: boolean;
}): AutomationMutationResponse {
  return {
    automation: toAutomation(response.schedule),
    created: response.created,
  };
}

// The Automations API is gated behind the zeroAutomations switch. When off, the
// surface is not reachable: handlers report not-found so the new paths are
// indistinguishable from unmounted routes.
const automationsEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.ZeroAutomations, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound("Resource not found");
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(bodyResultOf(automationsMainContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    deploySchedule$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      body: bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound(result.message);
  }
  if (result.kind === "bad_request") {
    return badRequestMessage(result.message);
  }
  if (result.kind === "schedule_past") {
    return {
      status: 400 as const,
      body: {
        error: {
          message: result.message,
          code: "SCHEDULE_PAST",
        },
      },
    };
  }
  return {
    status: result.status,
    body: toAutomationMutation(result.response),
  };
});

const updateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound("Resource not found");
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsByNameContract.update));
  const bodyResult = await get(bodyResultOf(automationsByNameContract.update));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  // Name is addressed by path; the deploy upsert is keyed on (agentId, name).
  const result = await set(
    deploySchedule$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      body: { ...bodyResult.data, name: params.name },
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound(result.message);
  }
  if (result.kind === "bad_request") {
    return badRequestMessage(result.message);
  }
  if (result.kind === "schedule_past") {
    return {
      status: 400 as const,
      body: {
        error: {
          message: result.message,
          code: "SCHEDULE_PAST",
        },
      },
    };
  }
  return {
    status: result.status,
    body: toAutomationMutation(result.response),
  };
});

const listInner$ = command(async ({ get }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound("Resource not found");
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const result = await get(
    zeroScheduleList({ orgId: auth.orgId, userId: auth.userId }),
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: toAutomationList(result) };
});

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound("Resource not found");
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsByNameContract.delete));
  const query = get(queryOf(automationsByNameContract.delete));

  const result = await set(
    deleteSchedule$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      agentId: query.agentId,
      name: params.name,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound("Resource not found");
  }
  return { status: 204 as const, body: undefined };
});

const disableInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound("Resource not found");
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsEnableContract.disable));
  const bodyResult = await get(bodyResultOf(automationsEnableContract.disable));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    disableSchedule$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      agentId: bodyResult.data.agentId,
      name: params.name,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound("Resource not found");
  }
  return {
    status: 200 as const,
    body: toAutomation(result.response),
  };
});

const enableInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound("Resource not found");
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsEnableContract.enable));
  const bodyResult = await get(bodyResultOf(automationsEnableContract.enable));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    enableSchedule$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      agentId: bodyResult.data.agentId,
      name: params.name,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound("Resource not found");
  }
  if (result.kind === "schedule_past") {
    return {
      status: 400 as const,
      body: {
        error: {
          message: "Schedule time has already passed",
          code: "SCHEDULE_PAST",
        },
      },
    };
  }
  return {
    status: 200 as const,
    body: toAutomation(result.response),
  };
});

const runNowInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound("Resource not found");
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(bodyResultOf(automationRunContract.run));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    runScheduleNow$,
    {
      body: { scheduleId: bodyResult.data.automationId },
      orgId: auth.orgId,
      apiStartTime: now(),
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound(result.message);
  }
  if (result.kind === "conflict") {
    return conflict(result.message);
  }
  if (result.kind === "run_error") {
    return result.response;
  }
  return { status: 201 as const, body: { runId: result.runId } };
});

export const automationsRoutes: readonly RouteEntry[] = [
  {
    route: automationsMainContract.create,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:write",
      },
      createInner$,
    ),
  },
  {
    route: automationsMainContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:read",
      },
      listInner$,
    ),
  },
  {
    route: automationsByNameContract.update,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:write",
      },
      updateInner$,
    ),
  },
  {
    route: automationsByNameContract.delete,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:delete",
      },
      deleteInner$,
    ),
  },
  {
    route: automationsEnableContract.disable,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:write",
      },
      disableInner$,
    ),
  },
  {
    route: automationsEnableContract.enable,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:write",
      },
      enableInner$,
    ),
  },
  {
    route: automationRunContract.run,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      runNowInner$,
    ),
  },
];
