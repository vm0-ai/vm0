import { computed } from "ccstate";
import { webhookWorkflowTriggerContract } from "@vm0/api-contracts/contracts/webhooks";
import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";

import {
  workflowAutomationReadAuth,
  workflowAutomationRouteHandlers,
  workspaceWorkflowAutomationEntries$,
} from "./zero-workflow-automations";
import { postWorkflowAutomationWebhook$ } from "./webhooks-workflow-automations";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";

const listWorkspaceLegacyWorkflowTriggersInner$ = computed(async (get) => {
  const entries = await get(workspaceWorkflowAutomationEntries$);
  return { status: 200 as const, body: [...entries] };
});

const listWorkspaceLegacyWorkflowTriggersHandler = authRoute(
  workflowAutomationReadAuth,
  listWorkspaceLegacyWorkflowTriggersInner$,
);

/**
 * Temporary compatibility routes for clients using the legacy workflow-trigger
 * API and inbound webhook path. Remove this file after legacy-path traffic
 * reaches zero for the sunset window tracked in #21408. The webhook alias is
 * not a permanent shim.
 */
export const legacyWorkflowTriggerAliasRoutes: readonly RouteEntry[] = [
  {
    route: webhookWorkflowTriggerContract.post,
    handler: postWorkflowAutomationWebhook$,
  },
  {
    route: zeroWorkflowTriggersContract.listWorkspace,
    handler: listWorkspaceLegacyWorkflowTriggersHandler,
  },
  {
    route: zeroWorkflowTriggersContract.listForChatThread,
    handler: workflowAutomationRouteHandlers.listForChatThread,
  },
  {
    route: zeroWorkflowTriggersContract.list,
    handler: workflowAutomationRouteHandlers.list,
  },
  {
    route: zeroWorkflowTriggersContract.create,
    handler: workflowAutomationRouteHandlers.create,
  },
  {
    route: zeroWorkflowTriggersContract.get,
    handler: workflowAutomationRouteHandlers.get,
  },
  {
    route: zeroWorkflowTriggersContract.update,
    handler: workflowAutomationRouteHandlers.update,
  },
  {
    route: zeroWorkflowTriggersContract.delete,
    handler: workflowAutomationRouteHandlers.delete,
  },
  {
    route: zeroWorkflowTriggersContract.enable,
    handler: workflowAutomationRouteHandlers.enable,
  },
  {
    route: zeroWorkflowTriggersContract.disable,
    handler: workflowAutomationRouteHandlers.disable,
  },
  {
    route: zeroWorkflowTriggersContract.run,
    handler: workflowAutomationRouteHandlers.run,
  },
  {
    route: zeroWorkflowTriggersContract.revealWebhookSecret,
    handler: workflowAutomationRouteHandlers.revealWebhookSecret,
  },
];
