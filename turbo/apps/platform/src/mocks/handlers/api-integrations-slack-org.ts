import {
  type SlackOrgStatus,
  integrationsSlackContract,
} from "@okouai/api-contracts/contracts/integrations-slack";
import { slackChannelsContract } from "@okouai/api-contracts/contracts/slack-channels";
import { mockApi } from "../msw-contract.ts";

let mockSlackOrgData: SlackOrgStatus = {
  isConnected: true,
  isInstalled: true,
  workspaceName: "Test Org Workspace",
  isAdmin: true,
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
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
}

export const apiIntegrationsSlackOrgHandlers = [
  // GET /api/okou/integrations/slack
  mockApi(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, mockSlackOrgData);
  }),

  // DELETE /api/okou/integrations/slack
  mockApi(integrationsSlackContract.disconnect, ({ query, respond }) => {
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

  // GET /api/slack/channels
  mockApi(slackChannelsContract.list, ({ respond }) => {
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
