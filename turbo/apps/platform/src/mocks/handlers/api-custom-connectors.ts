import { mockApi } from "../msw-contract.ts";
import { zeroCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";

let mockCustomConnectors: CustomConnectorResponse[] = [];

export function setMockCustomConnectors(connectors: CustomConnectorResponse[]): void {
  mockCustomConnectors = connectors;
}

export function resetMockCustomConnectors(): void {
  mockCustomConnectors = [
    {
      id: "cc111111-1111-1111-1111-111111111111",
      slug: "test-custom-connector",
      displayName: "Test Custom Connector",
      prefixes: ["test://"],
      headerName: "Authorization",
      headerTemplate: "Bearer {{secret}}",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      hasSecret: true,
    },
    {
      id: "cc222222-2222-2222-2222-222222222222",
      slug: "another-connector",
      displayName: "Another Connector",
      prefixes: ["another://"],
      headerName: "X-API-Key",
      headerTemplate: "{{secret}}",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      hasSecret: false,
    },
  ];
}

export const customConnectorHandlers = [
  mockApi(zeroCustomConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: mockCustomConnectors,
    });
  }),
];