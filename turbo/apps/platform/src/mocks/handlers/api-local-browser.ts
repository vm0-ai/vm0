import {
  zeroLocalBrowserDeviceClaimContract,
  zeroLocalBrowserHostsContract,
  type LocalBrowserHost,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import { zeroLocalBrowserConnectorContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { mockApi } from "../msw-contract.ts";
import { upsertMockConnector } from "./api-connectors.ts";

let mockLocalBrowserHosts: LocalBrowserHost[] = [];
let mockClaimedDeviceCodes: string[] = [];

export function setMockLocalBrowserHosts(hosts: LocalBrowserHost[]): void {
  mockLocalBrowserHosts = hosts;
}

export function getMockClaimedLocalBrowserDeviceCodes(): readonly string[] {
  return mockClaimedDeviceCodes;
}

export function resetMockLocalBrowserHosts(): void {
  mockLocalBrowserHosts = [];
  mockClaimedDeviceCodes = [];
}

export const apiLocalBrowserHandlers = [
  mockApi(zeroLocalBrowserHostsContract.list, ({ respond }) => {
    return respond(200, { hosts: mockLocalBrowserHosts });
  }),
  mockApi(zeroLocalBrowserHostsContract.delete, ({ params, respond }) => {
    const existing = mockLocalBrowserHosts.find((host) => {
      return host.id === params.hostId;
    });
    if (!existing) {
      return respond(404, {
        error: {
          message: "Local browser host not found",
          code: "NOT_FOUND",
        },
      });
    }
    mockLocalBrowserHosts = mockLocalBrowserHosts.filter((host) => {
      return host.id !== params.hostId;
    });
    return respond(200, { ok: true });
  }),
  mockApi(zeroLocalBrowserDeviceClaimContract.claim, ({ body, respond }) => {
    mockClaimedDeviceCodes = [...mockClaimedDeviceCodes, body.deviceCode];
    if (mockLocalBrowserHosts.length === 0) {
      const now = new Date().toISOString();
      mockLocalBrowserHosts = [
        {
          id: "browser-host-online",
          displayName: "Chrome",
          browser: "Chrome",
          extensionVersion: "0.1.0",
          supportedCapabilities: ["tabs.list", "page.snapshot"],
          status: "online",
          lastSeenAt: now,
          createdAt: now,
        },
      ];
    }
    return respond(200, { status: "approved" });
  }),
  mockApi(zeroLocalBrowserConnectorContract.create, ({ respond }) => {
    const hasOnlineHost = mockLocalBrowserHosts.some((host) => {
      return host.status === "online";
    });
    if (!hasOnlineHost) {
      return respond(409, {
        error: {
          message: "Pair an online browser host before connecting",
          code: "CONFLICT",
        },
      });
    }

    const now = new Date().toISOString();
    const connector = {
      id: "00000000-0000-4000-8000-000000000001",
      type: "local-browser" as const,
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
