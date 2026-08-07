import { http, HttpResponse } from "msw";
import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";

export function customConnector(
  overrides: Partial<CustomConnectorResponse> = {},
): CustomConnectorResponse {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "_acme-search",
    displayName: "Acme Search",
    prefixes: ["https://api.acme.test/v1/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{apiKey}}",
    prefixTemplates: ["https://api.acme.test/v1/"],
    fields: [
      {
        key: "apiKey",
        label: "API key",
        kind: "secret",
        required: true,
      },
    ],
    headerInjections: [],
    queryInjections: [],
    authMode: "manual",
    revision: 1,
    connected: false,
    missingRequiredFields: ["apiKey"],
    configuredFieldKeys: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    hasSecret: false,
    ...overrides,
  };
}

export function stubCustomConnectors(
  connectors: readonly CustomConnectorResponse[],
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/zero/custom-connectors`, () => {
    return HttpResponse.json({ connectors });
  });
}

export function stubAgentCustomConnectors(
  enabledIds: readonly string[],
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/zero/agents/:id/custom-connectors`, () => {
    return HttpResponse.json({ enabledIds });
  });
}
