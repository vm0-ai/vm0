import { command } from "ccstate";
import {
  automationsV2ByRefContract,
  automationsV2MainContract,
  automationTriggersV2Contract,
  type AutomationResponseV2,
  type AutomationTriggerResponse,
} from "@vm0/api-contracts/contracts/automations-v2";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { now } from "../external/time";
import {
  addTriggerV2$,
  createAutomationV2$,
  deleteAutomationV2$,
  listAutomationsV2$,
  removeTriggerV2$,
  rotateTriggerSecretV2$,
  runAutomationNowV2$,
  setAutomationEnabledV2$,
  setTriggerEnabledV2$,
  showAutomationV2$,
  showTriggerV2$,
  updateAutomationV2$,
  type AutomationTriggerRow,
  type AutomationViewV2,
} from "../services/automations-v2.service";
import { webhookUrlForToken } from "../services/webhook-automations.service";
import { automationsEnabled$ } from "./automations";
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
  if (trigger.kind === "webhook" && trigger.webhookToken !== null) {
    return {
      ...base,
      kind: "webhook",
      webhookToken: trigger.webhookToken,
      webhookUrl: webhookUrlForToken(trigger.webhookToken),
    };
  }
  // The B4 CHECK constraint guarantees each kind carries exactly its config.
  throw new Error(`Malformed automation trigger row ${trigger.id}`);
}

function automationResponse(view: AutomationViewV2): AutomationResponseV2 {
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
  if (!(await get(automationsEnabled$))) {
    return notFound(NOT_FOUND_MESSAGE);
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(bodyResultOf(automationsV2MainContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    createAutomationV2$,
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
      ...(result.webhookSecret !== undefined
        ? { webhookSecret: result.webhookSecret }
        : {}),
    },
  };
});

const listInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound(NOT_FOUND_MESSAGE);
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const views = await set(
    listAutomationsV2$,
    { userId: auth.userId, orgId: auth.orgId },
    signal,
  );
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { automations: views.map(automationResponse) },
  };
});

const showInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound(NOT_FOUND_MESSAGE);
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsV2ByRefContract.show));

  const result = await set(
    showAutomationV2$,
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
  if (!(await get(automationsEnabled$))) {
    return notFound(NOT_FOUND_MESSAGE);
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsV2ByRefContract.update));
  const bodyResult = await get(bodyResultOf(automationsV2ByRefContract.update));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    updateAutomationV2$,
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
  if (!(await get(automationsEnabled$))) {
    return notFound(NOT_FOUND_MESSAGE);
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsV2ByRefContract.delete));

  const result = await set(
    deleteAutomationV2$,
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
    if (!(await get(automationsEnabled$))) {
      return notFound(NOT_FOUND_MESSAGE);
    }
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(automationsV2ByRefContract.enable));

    const result = await set(
      setAutomationEnabledV2$,
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
  if (!(await get(automationsEnabled$))) {
    return notFound(NOT_FOUND_MESSAGE);
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsV2ByRefContract.run));

  const result = await set(
    runAutomationNowV2$,
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

const addTriggerInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound(NOT_FOUND_MESSAGE);
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsV2ByRefContract.addTrigger));
  const bodyResult = await get(
    bodyResultOf(automationsV2ByRefContract.addTrigger),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    addTriggerV2$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      ref: params.ref,
      request: bodyResult.data,
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
  return {
    status: 201 as const,
    body: {
      trigger: triggerResponse(result.trigger),
      ...(result.webhookSecret !== undefined
        ? { webhookSecret: result.webhookSecret }
        : {}),
    },
  };
});

const listTriggersInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(automationsEnabled$))) {
      return notFound(NOT_FOUND_MESSAGE);
    }
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(automationsV2ByRefContract.listTriggers));

    const result = await set(
      showAutomationV2$,
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
    return {
      status: 200 as const,
      body: { triggers: result.view.triggers.map(triggerResponse) },
    };
  },
);

const showTriggerInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound(NOT_FOUND_MESSAGE);
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationTriggersV2Contract.show));

  const result = await set(
    showTriggerV2$,
    { userId: auth.userId, orgId: auth.orgId, id: params.id },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound(NOT_FOUND_MESSAGE);
  }
  return { status: 200 as const, body: triggerResponse(result.trigger) };
});

const removeTriggerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(automationsEnabled$))) {
      return notFound(NOT_FOUND_MESSAGE);
    }
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(automationTriggersV2Contract.remove));

    const result = await set(
      removeTriggerV2$,
      { userId: auth.userId, orgId: auth.orgId, id: params.id },
      signal,
    );
    signal.throwIfAborted();

    if (result.kind === "not_found") {
      return notFound(NOT_FOUND_MESSAGE);
    }
    return { status: 204 as const, body: undefined };
  },
);

function makeSetTriggerEnabledInner(enabled: boolean) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(automationsEnabled$))) {
      return notFound(NOT_FOUND_MESSAGE);
    }
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(automationTriggersV2Contract.enable));

    const result = await set(
      setTriggerEnabledV2$,
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

const rotateSecretInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(automationsEnabled$))) {
      return notFound(NOT_FOUND_MESSAGE);
    }
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(automationTriggersV2Contract.rotateSecret));

    const result = await set(
      rotateTriggerSecretV2$,
      { userId: auth.userId, orgId: auth.orgId, id: params.id },
      signal,
    );
    signal.throwIfAborted();

    if (result.kind === "not_found" || result.kind === "ambiguous") {
      return notFound(NOT_FOUND_MESSAGE);
    }
    if (result.kind === "bad_request") {
      return badRequestMessage(result.message);
    }
    return {
      status: 200 as const,
      body: {
        trigger: triggerResponse(result.trigger),
        ...(result.webhookSecret !== undefined
          ? { webhookSecret: result.webhookSecret }
          : {}),
      },
    };
  },
);

export const automationsV2Routes: readonly RouteEntry[] = [
  {
    route: automationsV2MainContract.create,
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
    route: automationsV2MainContract.list,
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
    route: automationsV2ByRefContract.show,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:read",
      },
      showInner$,
    ),
  },
  {
    route: automationsV2ByRefContract.update,
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
    route: automationsV2ByRefContract.delete,
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
    route: automationsV2ByRefContract.enable,
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
    route: automationsV2ByRefContract.disable,
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
    route: automationsV2ByRefContract.run,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      runInner$,
    ),
  },
  {
    route: automationsV2ByRefContract.addTrigger,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:write",
      },
      addTriggerInner$,
    ),
  },
  {
    route: automationsV2ByRefContract.listTriggers,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:read",
      },
      listTriggersInner$,
    ),
  },
  {
    route: automationTriggersV2Contract.show,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:read",
      },
      showTriggerInner$,
    ),
  },
  {
    route: automationTriggersV2Contract.remove,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:delete",
      },
      removeTriggerInner$,
    ),
  },
  {
    route: automationTriggersV2Contract.enable,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:write",
      },
      enableTriggerInner$,
    ),
  },
  {
    route: automationTriggersV2Contract.disable,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:write",
      },
      disableTriggerInner$,
    ),
  },
  {
    route: automationTriggersV2Contract.rotateSecret,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:write",
      },
      rotateSecretInner$,
    ),
  },
];
