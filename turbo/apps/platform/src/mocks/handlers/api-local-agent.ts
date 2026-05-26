import {
  zeroLocalAgentHostsContract,
  type LocalAgentHost,
} from "@vm0/api-contracts/contracts/zero-local-agent";
import { zeroLocalAgentConnectorContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { mockApi } from "../msw-contract.ts";
import { upsertMockConnector } from "./api-connectors.ts";

let mockLocalAgentHosts: LocalAgentHost[] = [];
let mockLocalAgentHostsRequestCount = 0;

export function setMockLocalAgentHosts(hosts: LocalAgentHost[]): void {
  mockLocalAgentHosts = hosts;
}

export function getMockLocalAgentHostsRequestCount(): number {
  return mockLocalAgentHostsRequestCount;
}

export function resetMockLocalAgentHosts(): void {
  mockLocalAgentHosts = [];
  mockLocalAgentHostsRequestCount = 0;
}

export const apiLocalAgentHandlers = [
  mockApi(zeroLocalAgentHostsContract.list, ({ respond }) => {
    mockLocalAgentHostsRequestCount += 1;
    return respond(200, { hosts: mockLocalAgentHosts });
  }),
  mockApi(zeroLocalAgentConnectorContract.create, ({ respond }) => {
    const hasOnlineHost = mockLocalAgentHosts.some((host) => {
      return host.status === "online";
    });
    if (!hasOnlineHost) {
      return respond(409, {
        error: {
          message: "Start an online local-agent host before connecting",
          code: "CONFLICT",
        },
      });
    }

    const now = new Date().toISOString();
    const connector = {
      id: "00000000-0000-4000-8000-000000000000",
      type: "local-agent" as const,
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
