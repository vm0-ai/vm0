import { command } from "ccstate";
import {
  automationsByRefContract,
  automationsMainContract,
  automationTriggersContract,
  type AutomationResponse,
  type AutomationTriggerResponse,
} from "@vm0/api-contracts/contracts/automations";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { now } from "../external/time";
import { upsertMemberRoleCache$ } from "../services/auth.service";
import {
  listChatThreadWorkflowTriggers,
  setChatThreadWorkflowTriggerEnabled,
} from "../services/zero-workflow-trigger.service";
import {
  createAutomation$,
  deleteAutomation$,
  listAutomations$,
  runAutomationNow$,
  setAutomationEnabled$,
  setTriggerEnabled$,
  showAutomation$,
  showTrigger$,
  updateAutomation$,
  updateTrigger$,
  type AutomationTriggerRow,
  type AutomationView,
} from "../services/automations.service";
import type { RouteEntry } from "../route";

const NOT_FOUND_MESSAGE = "Resource not found";
const AMBIGUOUS_MESSAGE = "Ambiguous name, use the id";

function triggerResponse(
  trigger: AutomationTriggerRow,
): AutomationTriggerResponse {
  const base = {
    id: trigger.id,
    automationId: trigger.automationId,
    enabled: trigger.enabled,
    createdAt: trigger.createdAt.toISOString(),
    updatedAt: trigger.updatedAt.toISOString(),
  };
  const timeRuntime = {
    timezone: trigger.timezone,
    nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
    lastRunAt: trigger.lastRunAt?.toISOString() ?? null,
    consecutiveFailures: trigger.consecutiveFailures,
  };
  if (trigger.kind === "cron" && trigger.cronExpression !== null) {
    return {
      ...base,
      kind: "cron",
      cronExpression: trigger.cronExpression,
      ...timeRuntime,
    };
  }
  if (trigger.kind === "once" && trigger.atTime !== null) {
    return {
      ...base,
      kind: "once",
      atTime: trigger.atTime.toISOString(),
      ...timeRuntime,
    };
  }
  if (trigger.kind === "loop" && trigger.intervalSeconds !== null) {
    return {
      ...base,
      kind: "loop",
      intervalSeconds: trigger.intervalSeconds,
      ...timeRuntime,
    };
  }
  // The CHECK constraint guarantees each kind carries exactly its config.
  throw new Error(`Malformed automation trigger row ${trigger.id}`);
}

function automationResponse(view: AutomationView): AutomationResponse {
  const { automation } = view;
  return {
    id: automation.id,
    agentId: automation.agentId,
    displayName: view.displayName,
    userId: automation.userId,
    name: automation.name,
    description: automation.description,
    instruction: automation.instruction,
    appendSystemPrompt: automation.appendSystemPrompt,
    enabled: automation.enabled,
    chatThreadId: automation.chatThreadId,
    createdAt: automation.createdAt.toISOString(),
    updatedAt: automation.updatedAt.toISOString(),
    triggers: view.triggers.map(triggerResponse),
  };
}

const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(bodyResultOf(automationsMainContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  if (auth.orgRole !== undefined) {
    await set(
      upsertMemberRoleCache$,
      auth.orgId,
      auth.userId,
      auth.orgRole,
      signal,
    );
    signal.throwIfAborted();
  }

  const result = await set(
    createAutomation$,
    { userId: auth.userId, orgId: auth.orgId, body: bodyResult.data },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound(result.message);
  }
  if (result.kind === "bad_request") {
    return badRequestMessage(result.message);
  }
  return {
    status: 201 as const,
    body: {
      automation: automationResponse(result.view),
    },
  };
});

const listInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const views = await set(
    listAutomations$,
    { userId: auth.userId, orgId: auth.orgId },
    signal,
  );
  signal.throwIfAborted();
  const workflowTriggers = await listChatThreadWorkflowTriggers(set(writeDb$), {
    userId: auth.userId,
    orgId: auth.orgId,
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      automations: views.map(automationResponse),
      workflowTriggers: [...workflowTriggers],
    },
  };
});

const toggleWorkflowTriggerBody$ = bodyResultOf(
  automationsMainContract.toggleWorkflowTrigger,
);

const toggleWorkflowTriggerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(automationsMainContract.toggleWorkflowTrigger),
    );
    const bodyResult = await get(toggleWorkflowTriggerBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await setChatThreadWorkflowTriggerEnabled(set(writeDb$), {
      orgId: auth.orgId,
      userId: auth.userId,
      triggerId: params.id,
      enabled: bodyResult.data.enabled,
    });
    signal.throwIfAborted();
    if (result === "not-found") {
      return notFound(NOT_FOUND_MESSAGE);
    }
    return { status: 204 as const, body: undefined };
  },
);

const showInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsByRefContract.show));

  const result = await set(
    showAutomation$,
    { userId: auth.userId, orgId: auth.orgId, ref: params.ref },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound(NOT_FOUND_MESSAGE);
  }
  if (result.kind === "ambiguous") {
    return badRequestMessage(AMBIGUOUS_MESSAGE);
  }
  if (result.kind === "bad_request") {
    return badRequestMessage(result.message);
  }
  return { status: 200 as const, body: automationResponse(result.view) };
});

const updateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsByRefContract.update));
  const bodyResult = await get(bodyResultOf(automationsByRefContract.update));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    updateAutomation$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      ref: params.ref,
      body: bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound(NOT_FOUND_MESSAGE);
  }
  if (result.kind === "ambiguous") {
    return badRequestMessage(AMBIGUOUS_MESSAGE);
  }
  if (result.kind === "bad_request") {
    return badRequestMessage(result.message);
  }
  return { status: 200 as const, body: automationResponse(result.view) };
});

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsByRefContract.delete));

  const result = await set(
    deleteAutomation$,
    { userId: auth.userId, orgId: auth.orgId, ref: params.ref },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound(NOT_FOUND_MESSAGE);
  }
  if (result.kind === "ambiguous") {
    return badRequestMessage(AMBIGUOUS_MESSAGE);
  }
  return { status: 204 as const, body: undefined };
});

function makeSetEnabledInner(enabled: boolean) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(automationsByRefContract.enable));

    if (enabled && auth.orgRole !== undefined) {
      await set(
        upsertMemberRoleCache$,
        auth.orgId,
        auth.userId,
        auth.orgRole,
        signal,
      );
      signal.throwIfAborted();
    }

    const result = await set(
      setAutomationEnabled$,
      { userId: auth.userId, orgId: auth.orgId, ref: params.ref, enabled },
      signal,
    );
    signal.throwIfAborted();

    if (result.kind === "not_found") {
      return notFound(NOT_FOUND_MESSAGE);
    }
    if (result.kind === "ambiguous") {
      return badRequestMessage(AMBIGUOUS_MESSAGE);
    }
    if (result.kind === "bad_request") {
      return badRequestMessage(result.message);
    }
    return { status: 200 as const, body: automationResponse(result.view) };
  });
}

const enableInner$ = makeSetEnabledInner(true);
const disableInner$ = makeSetEnabledInner(false);

const runInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsByRefContract.run));

  const result = await set(
    runAutomationNow$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      ref: params.ref,
      apiStartTime: now(),
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound(NOT_FOUND_MESSAGE);
  }
  if (result.kind === "ambiguous") {
    return badRequestMessage(AMBIGUOUS_MESSAGE);
  }
  if (result.kind === "conflict") {
    return conflict(result.message);
  }
  if (result.kind === "run_error") {
    return result.response;
  }
  return { status: 201 as const, body: { runId: result.runId } };
});

const showTriggerInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationTriggersContract.show));

  const result = await set(
    showTrigger$,
    { userId: auth.userId, orgId: auth.orgId, id: params.id },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound(NOT_FOUND_MESSAGE);
  }
  return { status: 200 as const, body: triggerResponse(result.trigger) };
});

const updateTriggerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(automationTriggersContract.update));
    const bodyResult = await get(
      bodyResultOf(automationTriggersContract.update),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      updateTrigger$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        id: params.id,
        body: bodyResult.data,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.kind === "not_found" || result.kind === "ambiguous") {
      return notFound(NOT_FOUND_MESSAGE);
    }
    if (result.kind === "bad_request") {
      return badRequestMessage(result.message);
    }
    return { status: 200 as const, body: triggerResponse(result.trigger) };
  },
);

function makeSetTriggerEnabledInner(enabled: boolean) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(automationTriggersContract.enable));

    const result = await set(
      setTriggerEnabled$,
      { userId: auth.userId, orgId: auth.orgId, id: params.id, enabled },
      signal,
    );
    signal.throwIfAborted();

    if (result.kind === "not_found" || result.kind === "ambiguous") {
      return notFound(NOT_FOUND_MESSAGE);
    }
    if (result.kind === "bad_request") {
      return badRequestMessage(result.message);
    }
    return { status: 200 as const, body: triggerResponse(result.trigger) };
  });
}

const enableTriggerInner$ = makeSetTriggerEnabledInner(true);
const disableTriggerInner$ = makeSetTriggerEnabledInner(false);

export const automationsRoutes: readonly RouteEntry[] = [
  {
    route: automationsMainContract.create,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:write",
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
        requiredCapability: "automation:read",
      },
      listInner$,
    ),
  },
  {
    route: automationsMainContract.toggleWorkflowTrigger,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:write",
      },
      toggleWorkflowTriggerInner$,
    ),
  },
  {
    route: automationsByRefContract.show,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:read",
      },
      showInner$,
    ),
  },
  {
    route: automationsByRefContract.update,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:write",
      },
      updateInner$,
    ),
  },
  {
    route: automationsByRefContract.delete,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:delete",
      },
      deleteInner$,
    ),
  },
  {
    route: automationsByRefContract.enable,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:write",
      },
      enableInner$,
    ),
  },
  {
    route: automationsByRefContract.disable,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:write",
      },
      disableInner$,
    ),
  },
  {
    route: automationsByRefContract.run,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      runInner$,
    ),
  },
  {
    route: automationTriggersContract.show,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:read",
      },
      showTriggerInner$,
    ),
  },
  {
    route: automationTriggersContract.update,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:write",
      },
      updateTriggerInner$,
    ),
  },
  {
    route: automationTriggersContract.enable,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:write",
      },
      enableTriggerInner$,
    ),
  },
  {
    route: automationTriggersContract.disable,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:write",
      },
      disableTriggerInner$,
    ),
  },
];
