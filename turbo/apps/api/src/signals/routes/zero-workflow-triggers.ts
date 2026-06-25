import { command, computed } from "ccstate";
import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import {
  loadVisibleWorkflowById,
  type WorkflowMember,
} from "../services/zero-workflow-data.service";
import {
  createWorkflowTrigger$,
  deleteWorkflowTrigger$,
  disableWorkflowTrigger$,
  enableWorkflowTrigger$,
  getWorkflowTrigger,
  listThreadBoundWorkflowTriggers,
  loadWorkflowTriggers,
  setWorkflowTriggerPermissionPolicy$,
  updateWorkflowTrigger$,
  type TriggerResult,
} from "../services/zero-workflow-trigger.service";
import type { RouteEntry } from "../route";

const workflowReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const workflowWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

// The unattended permission policy is set only from a browser session or PAT,
// never from an in-run agent token (sandbox/zero). This prevents an unattended
// run from self-escalating the permissions of the trigger it runs under. See
// issue #18789.
const workflowPermissionPolicyWriteAuth = {
  ...workflowWriteAuth,
  accept: ["session", "pat"],
} as const;

function memberFromAuth(auth: {
  readonly userId: string;
  readonly orgRole?: string | null;
}): WorkflowMember {
  return { userId: auth.userId, role: auth.orgRole ?? "member" };
}

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

function triggerErrorResponse(
  result: TriggerResult,
  notFoundMessage = "Workflow trigger not found",
) {
  switch (result.kind) {
    case "not-found": {
      return notFound(notFoundMessage);
    }
    case "forbidden": {
      return forbidden(result.message);
    }
    case "conflict": {
      return conflict(result.message);
    }
    case "bad-request": {
      return badRequestMessage(result.message);
    }
    default: {
      throw new Error(`Unexpected trigger result: ${result.kind}`);
    }
  }
}

const createTriggerBody$ = bodyResultOf(zeroWorkflowTriggersContract.create);
const updateTriggerBody$ = bodyResultOf(zeroWorkflowTriggersContract.update);
const setTriggerPermissionPolicyBody$ = bodyResultOf(
  zeroWorkflowTriggersContract.setPermissionPolicy,
);

const listChatThreadTriggersInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(
    pathParamsOf(zeroWorkflowTriggersContract.listForChatThread),
  );
  const db = get(db$);
  const triggers = await listThreadBoundWorkflowTriggers(db, {
    orgId: auth.orgId,
    userId: auth.userId,
    threadId: params.threadId,
  });
  return { status: 200 as const, body: [...triggers] };
});

const listTriggersInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroWorkflowTriggersContract.list));
  const db = get(db$);
  const visible = await loadVisibleWorkflowById(db, {
    orgId: auth.orgId,
    member: memberFromAuth(auth),
    workflowId: params.workflowId,
  });
  if (!visible) {
    return notFound(`Workflow not found: ${params.workflowId}`);
  }
  const triggers = await loadWorkflowTriggers(db, {
    orgId: auth.orgId,
    workflowId: visible.workflow.id,
    userId: auth.userId,
  });
  return { status: 200 as const, body: [...triggers] };
});

const createTriggerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroWorkflowTriggersContract.create));
    const bodyResult = await get(createTriggerBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      createWorkflowTrigger$,
      "schedule" in bodyResult.data
        ? {
            orgId: auth.orgId,
            member: memberFromAuth(auth),
            workflowId: params.workflowId,
            schedule: bodyResult.data.schedule,
            enabled: bodyResult.data.enabled ?? true,
          }
        : {
            orgId: auth.orgId,
            member: memberFromAuth(auth),
            workflowId: params.workflowId,
            eventType: bodyResult.data.eventType,
            eventConfig: bodyResult.data.eventConfig,
            enabled: bodyResult.data.enabled ?? true,
          },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return { status: 201 as const, body: result.summary };
    }
    return triggerErrorResponse(
      result,
      `Workflow not found: ${params.workflowId}`,
    );
  },
);

const getTriggerInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroWorkflowTriggersContract.get));
  const db = get(db$);
  const trigger = await getWorkflowTrigger(db, {
    orgId: auth.orgId,
    member: memberFromAuth(auth),
    triggerId: params.id,
  });
  if (!trigger) {
    return notFound("Workflow trigger not found");
  }
  return { status: 200 as const, body: trigger };
});

const updateTriggerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroWorkflowTriggersContract.update));
    const bodyResult = await get(updateTriggerBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      updateWorkflowTrigger$,
      "schedule" in bodyResult.data
        ? {
            orgId: auth.orgId,
            member: memberFromAuth(auth),
            triggerId: params.id,
            schedule: bodyResult.data.schedule,
          }
        : {
            orgId: auth.orgId,
            member: memberFromAuth(auth),
            triggerId: params.id,
            eventConfig: bodyResult.data.eventConfig,
          },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return { status: 200 as const, body: result.summary };
    }
    return triggerErrorResponse(result);
  },
);

const setTriggerPermissionPolicyInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroWorkflowTriggersContract.setPermissionPolicy),
    );
    const bodyResult = await get(setTriggerPermissionPolicyBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const result = await set(
      setWorkflowTriggerPermissionPolicy$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        triggerId: params.id,
        policy: bodyResult.data.unattendedPermissionPolicy,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return { status: 200 as const, body: result.summary };
    }
    return triggerErrorResponse(result);
  },
);

const deleteTriggerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroWorkflowTriggersContract.delete));
    const result = await set(
      deleteWorkflowTrigger$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        triggerId: params.id,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "deleted") {
      return { status: 204 as const, body: undefined };
    }
    return triggerErrorResponse(result);
  },
);

const enableTriggerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroWorkflowTriggersContract.enable));
    const result = await set(
      enableWorkflowTrigger$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        triggerId: params.id,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return { status: 200 as const, body: result.summary };
    }
    return triggerErrorResponse(result);
  },
);

const disableTriggerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroWorkflowTriggersContract.disable));
    const result = await set(
      disableWorkflowTrigger$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        triggerId: params.id,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return { status: 200 as const, body: result.summary };
    }
    return triggerErrorResponse(result);
  },
);

export const zeroWorkflowTriggersRoutes: readonly RouteEntry[] = [
  {
    route: zeroWorkflowTriggersContract.listForChatThread,
    handler: authRoute(workflowReadAuth, listChatThreadTriggersInner$),
  },
  {
    route: zeroWorkflowTriggersContract.list,
    handler: authRoute(workflowReadAuth, listTriggersInner$),
  },
  {
    route: zeroWorkflowTriggersContract.create,
    handler: authRoute(workflowWriteAuth, createTriggerInner$),
  },
  {
    route: zeroWorkflowTriggersContract.get,
    handler: authRoute(workflowReadAuth, getTriggerInner$),
  },
  {
    route: zeroWorkflowTriggersContract.update,
    handler: authRoute(workflowWriteAuth, updateTriggerInner$),
  },
  {
    route: zeroWorkflowTriggersContract.delete,
    handler: authRoute(workflowWriteAuth, deleteTriggerInner$),
  },
  {
    route: zeroWorkflowTriggersContract.enable,
    handler: authRoute(workflowWriteAuth, enableTriggerInner$),
  },
  {
    route: zeroWorkflowTriggersContract.disable,
    handler: authRoute(workflowWriteAuth, disableTriggerInner$),
  },
  {
    route: zeroWorkflowTriggersContract.setPermissionPolicy,
    handler: authRoute(
      workflowPermissionPolicyWriteAuth,
      setTriggerPermissionPolicyInner$,
    ),
  },
];
