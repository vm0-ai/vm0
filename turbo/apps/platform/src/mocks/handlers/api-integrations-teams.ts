import {
  type TeamsConnectStatus,
  zeroTeamsConnectContract,
} from "@vm0/api-contracts/contracts/zero-teams-connect";
import { mockApi } from "../msw-contract.ts";

let mockTeamsData: TeamsConnectStatus = {
  isInstalled: false,
  isConnected: false,
  isAdmin: true,
  installUrl:
    "https://teams.microsoft.com/l/app/00000000-0000-0000-0000-000000000001",
  connectUrl:
    "/api/zero/teams/oauth/connect?orgId=org_mock&vm0UserId=user_mock",
};

export function resetMockTeamsIntegration(): void {
  mockTeamsData = {
    isInstalled: false,
    isConnected: false,
    isAdmin: true,
    installUrl:
      "https://teams.microsoft.com/l/app/00000000-0000-0000-0000-000000000001",
    connectUrl:
      "/api/zero/teams/oauth/connect?orgId=org_mock&vm0UserId=user_mock",
  };
}

export const apiIntegrationsTeamsHandlers = [
  mockApi(zeroTeamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, mockTeamsData);
  }),

  mockApi(zeroTeamsConnectContract.connect, ({ body, respond }) => {
    mockTeamsData = {
      ...mockTeamsData,
      isInstalled: true,
      isConnected: true,
      tenantId: body.tenantId,
      tenantName: mockTeamsData.tenantName ?? null,
      teamId: body.teamId ?? mockTeamsData.teamId ?? null,
      teamName: body.teamName ?? mockTeamsData.teamName ?? null,
      connectUrl: null,
    };
    return respond(200, {
      success: true,
      connectionId: "teams-conn-mock-001",
      role: mockTeamsData.isAdmin ? "admin" : "member",
    });
  }),

  mockApi(zeroTeamsConnectContract.disconnect, ({ query, respond }) => {
    if (query.action === "uninstall") {
      mockTeamsData = {
        ...mockTeamsData,
        isInstalled: false,
        isConnected: false,
        connectUrl:
          "/api/zero/teams/oauth/connect?orgId=org_mock&vm0UserId=user_mock",
      };
    } else {
      mockTeamsData = {
        ...mockTeamsData,
        isConnected: false,
        connectUrl:
          "/api/zero/teams/oauth/connect?orgId=org_mock&vm0UserId=user_mock",
      };
    }
    return respond(200, { success: true });
  }),
];
