import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { describe, expect, it } from "vitest";

import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../../signals/api-client.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function connectorCatalogClient() {
  void context.mocks;
  return context.store.get(apiClient$)(connectorCatalogContract);
}

describe("api connectors mock handlers", () => {
  it("does not treat a partial provider grant as catalog scope drift", async () => {
    const connector: ConnectorResponse = {
      id: "00000000-0000-4000-8000-000000000001",
      slug: "google-ads",
      authMethod: "oauth",
      externalId: "mock-google-ads-account",
      externalUsername: "mock-google-ads",
      externalEmail: "mock-google-ads@example.test",
      oauthScopes: ["https://www.googleapis.com/auth/adwords"],
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    context.mocks.data.connectors([connector]);

    const response = await accept(connectorCatalogClient().status(), [200]);
    expect(
      response.body.connectors.find((candidate) => {
        return candidate.slug === connector.slug;
      }),
    ).toMatchObject({
      connected: true,
      connectionStatus: "connected",
      scopeMismatch: false,
    });
  });
});
