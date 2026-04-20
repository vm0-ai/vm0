import {
  type CustomConnectorResponse,
  zeroCustomConnectorsContract,
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorSecretContract,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

let mockCustomConnectors: CustomConnectorResponse[] = [];

export function setMockCustomConnectors(
  connectors: CustomConnectorResponse[],
): void {
  mockCustomConnectors = [...connectors];
}

export function resetMockCustomConnectors(): void {
  mockCustomConnectors = [];
}

function makeConnector(
  overrides: Partial<CustomConnectorResponse> &
    Pick<CustomConnectorResponse, "id">,
): CustomConnectorResponse {
  return {
    slug: "acme-api",
    displayName: "Acme API",
    prefixes: ["https://api.acme.com/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
    hasSecret: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export const apiCustomConnectorsHandlers = [
  mockApi(zeroCustomConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: mockCustomConnectors });
  }),

  mockApi(zeroCustomConnectorsContract.create, ({ body, respond }) => {
    const created = makeConnector({
      id: crypto.randomUUID(),
      displayName: body.displayName,
      prefixes: body.prefixes,
      headerName: body.headerName,
      headerTemplate: body.headerTemplate,
    });
    mockCustomConnectors.push(created);
    return respond(201, created);
  }),

  mockApi(zeroCustomConnectorByIdContract.delete, ({ params, respond }) => {
    const idx = mockCustomConnectors.findIndex((c) => {
      return c.id === params.id;
    });
    if (idx === -1) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    mockCustomConnectors.splice(idx, 1);
    return respond(204);
  }),

  mockApi(
    zeroCustomConnectorByIdContract.patch,
    ({ params, body, respond }) => {
      const connector = mockCustomConnectors.find((c) => {
        return c.id === params.id;
      });
      if (!connector) {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }
      connector.displayName = body.displayName;
      connector.updatedAt = new Date().toISOString();
      return respond(200, connector);
    },
  ),

  mockApi(zeroCustomConnectorSecretContract.set, ({ params, respond }) => {
    const connector = mockCustomConnectors.find((c) => {
      return c.id === params.id;
    });
    if (!connector) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    connector.hasSecret = true;
    return respond(204);
  }),

  mockApi(zeroCustomConnectorSecretContract.delete, ({ params, respond }) => {
    const connector = mockCustomConnectors.find((c) => {
      return c.id === params.id;
    });
    if (!connector) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    connector.hasSecret = false;
    return respond(204);
  }),
];
