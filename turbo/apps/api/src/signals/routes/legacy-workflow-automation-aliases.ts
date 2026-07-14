import { computed } from "ccstate";
import { legacyWebhookWorkflowAutomationContract } from "@vm0/api-contracts/contracts/webhooks";
import { legacyZeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";

import {
  workflowAutomationReadAuth,
  workflowAutomationRouteHandlers,
  workspaceWorkflowAutomationEntries$,
} from "./zero-workflow-automations";
import { postWorkflowAutomationWebhook$ } from "./webhooks-workflow-automations";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";

const listWorkspaceLegacyWorkflowAutomationsInner$ = computed(async (get) => {
  const entries = await get(workspaceWorkflowAutomationEntries$);
  return { status: 200 as const, body: [...entries] };
});

const listWorkspaceLegacyWorkflowAutomationsHandler = authRoute(
  workflowAutomationReadAuth,
  listWorkspaceLegacyWorkflowAutomationsInner$,
);

/**
 * Temporary compatibility routes for clients using retired automation API and
 * inbound webhook paths. Remove this file after legacy-path traffic
 * reaches zero for the sunset window tracked in #21408. The webhook alias is
 * not a permanent shim.
 */
export const legacyWorkflowAutomationAliasRoutes: readonly RouteEntry[] = [
  {
    route: legacyWebhookWorkflowAutomationContract.post,
    handler: postWorkflowAutomationWebhook$,
  },
  {
    route: legacyZeroWorkflowAutomationsContract.listWorkspace,
    handler: listWorkspaceLegacyWorkflowAutomationsHandler,
  },
  {
    route: legacyZeroWorkflowAutomationsContract.listForChatThread,
    handler: workflowAutomationRouteHandlers.listForChatThread,
  },
  {
    route: legacyZeroWorkflowAutomationsContract.list,
    handler: workflowAutomationRouteHandlers.list,
  },
  {
    route: legacyZeroWorkflowAutomationsContract.create,
    handler: workflowAutomationRouteHandlers.create,
  },
  {
    route: legacyZeroWorkflowAutomationsContract.get,
    handler: workflowAutomationRouteHandlers.get,
  },
  {
    route: legacyZeroWorkflowAutomationsContract.update,
    handler: workflowAutomationRouteHandlers.update,
  },
  {
    route: legacyZeroWorkflowAutomationsContract.delete,
    handler: workflowAutomationRouteHandlers.delete,
  },
  {
    route: legacyZeroWorkflowAutomationsContract.enable,
    handler: workflowAutomationRouteHandlers.enable,
  },
  {
    route: legacyZeroWorkflowAutomationsContract.disable,
    handler: workflowAutomationRouteHandlers.disable,
  },
  {
    route: legacyZeroWorkflowAutomationsContract.run,
    handler: workflowAutomationRouteHandlers.run,
  },
  {
    route: legacyZeroWorkflowAutomationsContract.revealWebhookSecret,
    handler: workflowAutomationRouteHandlers.revealWebhookSecret,
  },
];
