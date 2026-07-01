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
  listWorkspaceWorkflowTriggers,
  loadWorkflowTriggers,
  runOwnedWorkflowTriggerNow$,
  updateWorkflowTrigger$,
  type TriggerResult,
} from "../services/zero-workflow-trigger.service";
import type { RouteEntry } from "../route-entry";

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

const listWorkspaceTriggersInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const db = get(db$);
  const triggers = await listWorkspaceWorkflowTriggers(db, {
    orgId: auth.orgId,
    member: memberFromAuth(auth),
  });
  return { status: 200 as const, body: [...triggers] };
});

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

    const triggerInputBase = {
      orgId: auth.orgId,
      member: memberFromAuth(auth),
      workflowId: params.workflowId,
      enabled: bodyResult.data.enabled ?? true,
    };
    const result =
      "schedule" in bodyResult.data
        ? await set(
            createWorkflowTrigger$,
            {
              ...triggerInputBase,
              schedule: bodyResult.data.schedule,
            },
            signal,
          )
        : bodyResult.data.eventType === "webhook-received"
          ? await set(
              createWorkflowTrigger$,
              {
                ...triggerInputBase,
                eventType: bodyResult.data.eventType,
                eventConfig: bodyResult.data.eventConfig,
              },
              signal,
            )
          : bodyResult.data.eventType === "github-label-applied"
            ? await set(
                createWorkflowTrigger$,
                {
                  ...triggerInputBase,
                  eventType: bodyResult.data.eventType,
                  eventConfig: bodyResult.data.eventConfig,
                },
                signal,
              )
            : bodyResult.data.eventType === "google-calendar-event-created" ||
                bodyResult.data.eventType === "google-calendar-event-updated"
              ? await set(
                  createWorkflowTrigger$,
                  {
                    ...triggerInputBase,
                    eventType: bodyResult.data.eventType,
                    eventConfig: bodyResult.data.eventConfig,
                  },
                  signal,
                )
              : await set(
                  createWorkflowTrigger$,
                  {
                    ...triggerInputBase,
                    eventType: bodyResult.data.eventType,
                    eventConfig: bodyResult.data.eventConfig,
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

const runTriggerInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroWorkflowTriggersContract.run));
  const result = await set(
    runOwnedWorkflowTriggerNow$,
    {
      orgId: auth.orgId,
      member: memberFromAuth(auth),
      triggerId: params.id,
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind === "ok") {
    return {
      status: 201 as const,
      body: {
        runId: result.runId,
        chatThreadId: result.chatThreadId,
      },
    };
  }
  if (result.kind === "run_error") {
    return result.response;
  }
  return triggerErrorResponse(result);
});

export const zeroWorkflowTriggersRoutes: readonly RouteEntry[] = [
  {
    route: zeroWorkflowTriggersContract.listWorkspace,
    handler: authRoute(workflowReadAuth, listWorkspaceTriggersInner$),
  },
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
    route: zeroWorkflowTriggersContract.run,
    handler: authRoute(workflowWriteAuth, runTriggerInner$),
  },
];
