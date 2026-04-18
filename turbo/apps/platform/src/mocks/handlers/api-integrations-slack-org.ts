/**
 * Org-aware Slack Integration API Handlers
 *
 * Mock handlers for /api/zero/integrations/slack endpoint.
 * Default behavior: user has a connected org Slack workspace.
 */

import {
  type SlackOrgStatus,
  zeroIntegrationsSlackContract,
  zeroSlackChannelsContract,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

let mockSlackOrgData: SlackOrgStatus = {
  isConnected: true,
  isInstalled: true,
  workspaceName: "Test Org Workspace",
  isAdmin: true,
  agentOrgSlug: "test-org",
  environment: {
    requiredSecrets: [],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  },
};

export function resetMockSlackOrgIntegration(): void {
  mockSlackOrgData = {
    isConnected: true,
    isInstalled: true,
    workspaceName: "Test Org Workspace",
    isAdmin: true,
    agentOrgSlug: "test-org",
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
}

export const apiIntegrationsSlackOrgHandlers = [
  // GET /api/zero/integrations/slack
  mockApi(zeroIntegrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, mockSlackOrgData);
  }),

  // DELETE /api/zero/integrations/slack
  mockApi(zeroIntegrationsSlackContract.disconnect, ({ query, respond }) => {
    if (query.action === "uninstall") {
      mockSlackOrgData = {
        ...mockSlackOrgData,
        isConnected: false,
        isInstalled: false,
      };
    } else {
      mockSlackOrgData = { ...mockSlackOrgData, isConnected: false };
    }
    return respond(200, { ok: true });
  }),

  // GET /api/zero/slack/channels
  mockApi(zeroSlackChannelsContract.list, ({ respond }) => {
    if (!mockSlackOrgData.isInstalled) {
      return respond(404, {
        error: { message: "No Slack installation", code: "NOT_FOUND" },
      });
    }
    return respond(200, {
      channels: [
        { id: "C-GENERAL", name: "general" },
        { id: "C-ALERTS", name: "alerts" },
      ],
    });
  }),
];
