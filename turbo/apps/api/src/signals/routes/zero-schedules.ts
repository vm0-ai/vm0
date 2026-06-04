import { command, computed } from "ccstate";
import {
  zeroScheduleMigrateChatContract,
  zeroScheduleRunContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
  zeroSchedulesMainContract,
} from "@vm0/api-contracts/contracts/zero-schedules";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import {
  deleteSchedule$,
  deploySchedule$,
  disableSchedule$,
  enableSchedule$,
  migrateScheduleToChat$,
  runScheduleNow$,
  zeroScheduleList,
} from "../services/zero-schedules.service";
import { now } from "../external/time";
import type { RouteEntry } from "../route";

const listSchedulesInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const result = await get(
    zeroScheduleList({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body: result };
});

const deployInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(bodyResultOf(zeroSchedulesMainContract.deploy));
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
  return { status: result.status, body: result.response };
});

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroSchedulesByNameContract.delete));
  const query = get(queryOf(zeroSchedulesByNameContract.delete));

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
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroSchedulesEnableContract.disable));
  const bodyResult = await get(
    bodyResultOf(zeroSchedulesEnableContract.disable),
  );
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
  return { status: 200 as const, body: result.response };
});

const enableInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroSchedulesEnableContract.enable));
  const bodyResult = await get(
    bodyResultOf(zeroSchedulesEnableContract.enable),
  );
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
  return { status: 200 as const, body: result.response };
});

const migrateToChatInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroScheduleMigrateChatContract.migrateToChat),
    );
    const bodyResult = await get(
      bodyResultOf(zeroScheduleMigrateChatContract.migrateToChat),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      migrateScheduleToChat$,
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
    if (result.kind === "bad_request") {
      return badRequestMessage(result.message);
    }
    return { status: 200 as const, body: result.response };
  },
);

const runNowInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(bodyResultOf(zeroScheduleRunContract.run));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    runScheduleNow$,
    {
      body: bodyResult.data,
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

export const zeroSchedulesRoutes: readonly RouteEntry[] = [
  {
    route: zeroSchedulesMainContract.deploy,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:write",
      },
      deployInner$,
    ),
  },
  {
    route: zeroSchedulesMainContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:read",
      },
      listSchedulesInner$,
    ),
  },
  {
    route: zeroSchedulesByNameContract.delete,
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
    route: zeroSchedulesEnableContract.disable,
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
    route: zeroSchedulesEnableContract.enable,
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
    route: zeroScheduleMigrateChatContract.migrateToChat,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:write",
      },
      migrateToChatInner$,
    ),
  },
  {
    route: zeroScheduleRunContract.run,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      runNowInner$,
    ),
  },
];
