import { computed } from "ccstate";
import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";

import {
  workflowAutomationReadAuth,
  workflowAutomationRouteHandlers,
  workspaceWorkflowAutomationEntries$,
} from "./zero-workflow-automations";
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
 * API. Remove this file after legacy-path traffic reaches zero for the sunset
 * window tracked in #21408.
 */
export const legacyWorkflowTriggerAliasRoutes: readonly RouteEntry[] = [
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
