import { command, computed } from "ccstate";
import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import {
  badRequestMessage,
  conflict,
  notFound,
  teamRequired,
} from "../../lib/error";
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
  revealWorkflowWebhookSecret,
  runOwnedWorkflowTriggerNow$,
  updateWorkflowTrigger$,
  type TriggerResult,
} from "../services/zero-workflow-trigger.service";
import type { RouteEntry } from "../route-entry";

export const workflowAutomationReadAuth = {
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
    case "team-required": {
      return teamRequired(result.message);
    }
    case "bad-request": {
      return badRequestMessage(result.message);
    }
    default: {
      throw new Error(`Unexpected trigger result: ${result.kind}`);
    }
  }
}

const createTriggerBody$ = bodyResultOf(zeroWorkflowAutomationsContract.create);
const updateTriggerBody$ = bodyResultOf(zeroWorkflowAutomationsContract.update);

export const workspaceWorkflowAutomationEntries$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const db = get(db$);
  return await listWorkspaceWorkflowTriggers(db, {
    orgId: auth.orgId,
    member: memberFromAuth(auth),
  });
});

const listWorkspaceAutomationsInner$ = computed(async (get) => {
  const entries = await get(workspaceWorkflowAutomationEntries$);
  return {
    status: 200 as const,
    body: entries.map(({ workflow, trigger }) => {
      return { workflow, automation: trigger };
    }),
  };
});

const listChatThreadTriggersInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(
    pathParamsOf(zeroWorkflowAutomationsContract.listForChatThread),
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
  const params = get(pathParamsOf(zeroWorkflowAutomationsContract.list));
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
    const params = get(pathParamsOf(zeroWorkflowAutomationsContract.create));
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
                bodyResult.data.eventType === "google-calendar-event-updated" ||
                bodyResult.data.eventType === "google-calendar-event-cancelled"
              ? await set(
                  createWorkflowTrigger$,
                  {
                    ...triggerInputBase,
                    eventType: bodyResult.data.eventType,
                    eventConfig: bodyResult.data.eventConfig,
                  },
                  signal,
                )
              : bodyResult.data.eventType === "google-meet-transcript-generated"
                ? await set(
                    createWorkflowTrigger$,
                    {
                      ...triggerInputBase,
                      eventType: bodyResult.data.eventType,
                      eventConfig: bodyResult.data.eventConfig,
                    },
                    signal,
                  )
                : bodyResult.data.eventType === "notion-child-page-created" ||
                    bodyResult.data.eventType ===
                      "notion-database-item-created" ||
                    bodyResult.data.eventType === "notion-page-content-updated"
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
  const params = get(pathParamsOf(zeroWorkflowAutomationsContract.get));
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

const revealWebhookSecretInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(
    pathParamsOf(zeroWorkflowAutomationsContract.revealWebhookSecret),
  );
  const db = get(db$);
  const secret = await revealWorkflowWebhookSecret(db, {
    orgId: auth.orgId,
    member: memberFromAuth(auth),
    triggerId: params.id,
  });
  if (!secret) {
    return notFound("Workflow webhook trigger not found");
  }
  return { status: 200 as const, body: secret };
});

const updateTriggerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroWorkflowAutomationsContract.update));
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
    const params = get(pathParamsOf(zeroWorkflowAutomationsContract.delete));
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
    const params = get(pathParamsOf(zeroWorkflowAutomationsContract.enable));
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
    const params = get(pathParamsOf(zeroWorkflowAutomationsContract.disable));
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
  const params = get(pathParamsOf(zeroWorkflowAutomationsContract.run));
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

export const workflowAutomationRouteHandlers = {
  listWorkspace: authRoute(
    workflowAutomationReadAuth,
    listWorkspaceAutomationsInner$,
  ),
  listForChatThread: authRoute(
    workflowAutomationReadAuth,
    listChatThreadTriggersInner$,
  ),
  list: authRoute(workflowAutomationReadAuth, listTriggersInner$),
  create: authRoute(workflowWriteAuth, createTriggerInner$),
  get: authRoute(workflowAutomationReadAuth, getTriggerInner$),
  update: authRoute(workflowWriteAuth, updateTriggerInner$),
  delete: authRoute(workflowWriteAuth, deleteTriggerInner$),
  enable: authRoute(workflowWriteAuth, enableTriggerInner$),
  disable: authRoute(workflowWriteAuth, disableTriggerInner$),
  run: authRoute(workflowWriteAuth, runTriggerInner$),
  revealWebhookSecret: authRoute(workflowWriteAuth, revealWebhookSecretInner$),
} as const;

export const zeroWorkflowAutomationsRoutes: readonly RouteEntry[] = [
  {
    route: zeroWorkflowAutomationsContract.listWorkspace,
    handler: workflowAutomationRouteHandlers.listWorkspace,
  },
  {
    route: zeroWorkflowAutomationsContract.listForChatThread,
    handler: workflowAutomationRouteHandlers.listForChatThread,
  },
  {
    route: zeroWorkflowAutomationsContract.list,
    handler: workflowAutomationRouteHandlers.list,
  },
  {
    route: zeroWorkflowAutomationsContract.create,
    handler: workflowAutomationRouteHandlers.create,
  },
  {
    route: zeroWorkflowAutomationsContract.get,
    handler: workflowAutomationRouteHandlers.get,
  },
  {
    route: zeroWorkflowAutomationsContract.update,
    handler: workflowAutomationRouteHandlers.update,
  },
  {
    route: zeroWorkflowAutomationsContract.delete,
    handler: workflowAutomationRouteHandlers.delete,
  },
  {
    route: zeroWorkflowAutomationsContract.enable,
    handler: workflowAutomationRouteHandlers.enable,
  },
  {
    route: zeroWorkflowAutomationsContract.disable,
    handler: workflowAutomationRouteHandlers.disable,
  },
  {
    route: zeroWorkflowAutomationsContract.run,
    handler: workflowAutomationRouteHandlers.run,
  },
  {
    route: zeroWorkflowAutomationsContract.revealWebhookSecret,
    handler: workflowAutomationRouteHandlers.revealWebhookSecret,
  },
];
