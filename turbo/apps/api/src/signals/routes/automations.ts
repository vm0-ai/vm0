import { command } from "ccstate";
import {
  automationsByRefContract,
  automationsMainContract,
  automationTriggersContract,
  type AutomationResponse,
  type AutomationTriggerResponse,
} from "@vm0/api-contracts/contracts/automations";

import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import {
  listAutomations$,
  showAutomation$,
  showTrigger$,
  type AutomationTriggerRow,
  type AutomationView,
} from "../services/automations.service";
import type { RouteEntry } from "../route-entry";

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

// Legacy automations are read-only provenance data after the workflow cutover
// (#19959): the scheduling system and every mutating route were removed
// (#20100). Only list/show remain so users can inspect their migrated rows;
// they go away with the tables in the Phase B removal (#20101).

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
    body: {
      automations: views.map(automationResponse),
    },
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
  return { status: 200 as const, body: automationResponse(result.view) };
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

export const automationsRoutes: readonly RouteEntry[] = [
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
];
