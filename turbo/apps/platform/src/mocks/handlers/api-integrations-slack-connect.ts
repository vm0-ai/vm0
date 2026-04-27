/**
 * Slack Connect API Handlers
 *
 * Mock handlers for /api/zero/integrations/slack/connect endpoint.
 * Default behavior: user is not yet connected.
 */

import { zeroSlackConnectContract } from "@vm0/api-contracts/contracts/zero-slack-connect";
import { mockApi } from "../msw-contract.ts";

interface MockSlackConnectData {
  isConnected: boolean;
  postError: string | null;
}

let mockData: MockSlackConnectData = {
  isConnected: false,
  postError: null,
};

export function setMockSlackConnectData(
  data: Partial<MockSlackConnectData>,
): void {
  mockData = { ...mockData, ...data };
}

export function resetMockSlackConnect(): void {
  mockData = {
    isConnected: false,
    postError: null,
  };
}

export const apiIntegrationsSlackConnectHandlers = [
  // GET /api/zero/integrations/slack/connect — check connection status
  mockApi(zeroSlackConnectContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: mockData.isConnected,
      isAdmin: false,
    });
  }),

  // POST /api/zero/integrations/slack/connect — connect account
  // body ({ workspaceId, slackUserId, channelId?, threadTs? }) is contract-typed
  // but not used for routing — the mock simulates errors via mockData.postError.
  mockApi(zeroSlackConnectContract.connect, ({ respond }) => {
    if (mockData.postError) {
      return respond(400, {
        error: { message: mockData.postError, code: "BAD_REQUEST" },
      });
    }
    return respond(200, {
      success: true,
      connectionId: "conn-mock-001",
      role: "member",
    });
  }),
];
