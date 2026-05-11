import { command, computed } from "ccstate";
import {
  zeroSchedulesEnableContract,
  zeroSchedulesMainContract,
} from "@vm0/api-contracts/contracts/zero-schedules";

import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  disableSchedule$,
  enableSchedule$,
  zeroScheduleList,
} from "../services/zero-schedules.service";
import type { RouteEntry } from "../route";

const listSchedulesInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const result = await get(
    zeroScheduleList({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body: result };
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

export const zeroSchedulesRoutes: readonly RouteEntry[] = [
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
];
