import { command, computed } from "ccstate";
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
import { now } from "../external/time";
import {
  addTrigger$,
  createAutomation$,
  deleteAutomation$,
  listAutomations$,
  removeTrigger$,
  rotateTriggerSecret$,
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
import { webhookUrlForToken } from "../services/webhook-automations.service";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
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

// Webhook triggers are a NEW capability gated separately from the automation
// surface itself (#17307): while off, automations stay feature-equivalent to
// legacy schedules (time triggers only). Creating webhook triggers, rotating
// their secrets, and the inbound dispatch all respect this switch.
const webhookTriggersEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.AutomationWebhookTriggers, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

const WEBHOOK_TRIGGERS_DISABLED_MESSAGE =
  "Webhook triggers are not enabled for this workspace";

const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(bodyResultOf(automationsMainContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  if (
    bodyResult.data.trigger?.kind === "webhook" &&
    !(await get(webhookTriggersEnabled$))
  ) {
    return badRequestMessage(WEBHOOK_TRIGGERS_DISABLED_MESSAGE);
  }
  signal.throwIfAborted();

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
      ...(result.webhookSecret !== undefined
        ? { webhookSecret: result.webhookSecret }
        : {}),
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
  return {
    status: 200 as const,
    body: { automations: views.map(automationResponse) },
  };
});

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

const addTriggerInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(automationsByRefContract.addTrigger));
  const bodyResult = await get(
    bodyResultOf(automationsByRefContract.addTrigger),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  if (
    bodyResult.data.kind === "webhook" &&
    !(await get(webhookTriggersEnabled$))
  ) {
    return badRequestMessage(WEBHOOK_TRIGGERS_DISABLED_MESSAGE);
  }
  signal.throwIfAborted();

  const result = await set(
    addTrigger$,
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
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(automationsByRefContract.listTriggers));

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
    return {
      status: 200 as const,
      body: { triggers: result.view.triggers.map(triggerResponse) },
    };
  },
);

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

const removeTriggerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(automationTriggersContract.remove));

    const result = await set(
      removeTrigger$,
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

const rotateSecretInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(webhookTriggersEnabled$))) {
      return badRequestMessage(WEBHOOK_TRIGGERS_DISABLED_MESSAGE);
    }
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(automationTriggersContract.rotateSecret));

    const result = await set(
      rotateTriggerSecret$,
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
    route: automationsByRefContract.addTrigger,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:write",
      },
      addTriggerInner$,
    ),
  },
  {
    route: automationsByRefContract.listTriggers,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:read",
      },
      listTriggersInner$,
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
    route: automationTriggersContract.remove,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:delete",
      },
      removeTriggerInner$,
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
  {
    route: automationTriggersContract.rotateSecret,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "automation:write",
      },
      rotateSecretInner$,
    ),
  },
];
