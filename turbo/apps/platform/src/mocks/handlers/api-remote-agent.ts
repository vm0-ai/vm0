import {
  zeroRemoteAgentHostsContract,
  type RemoteAgentHost,
} from "@vm0/api-contracts/contracts/zero-remote-agent";
import { zeroRemoteAgentConnectorContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { mockApi } from "../msw-contract.ts";
import { upsertMockConnector } from "./api-connectors.ts";

let mockRemoteAgentHosts: RemoteAgentHost[] = [];

export function setMockRemoteAgentHosts(hosts: RemoteAgentHost[]): void {
  mockRemoteAgentHosts = hosts;
}

export function resetMockRemoteAgentHosts(): void {
  mockRemoteAgentHosts = [];
}

export const apiRemoteAgentHandlers = [
  mockApi(zeroRemoteAgentHostsContract.list, ({ respond }) => {
    return respond(200, { hosts: mockRemoteAgentHosts });
  }),
  mockApi(zeroRemoteAgentConnectorContract.create, ({ respond }) => {
    const hasOnlineHost = mockRemoteAgentHosts.some((host) => {
      return host.status === "online";
    });
    if (!hasOnlineHost) {
      return respond(409, {
        error: {
          message: "Start an online remote-agent host before connecting",
          code: "CONFLICT",
        },
      });
    }

    const now = new Date().toISOString();
    const connector = {
      id: "00000000-0000-4000-8000-000000000000",
      type: "remote-agent" as const,
      authMethod: "api",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      needsReconnect: false,
      createdAt: now,
      updatedAt: now,
    };
    upsertMockConnector(connector);
    return respond(200, connector);
  }),
];
