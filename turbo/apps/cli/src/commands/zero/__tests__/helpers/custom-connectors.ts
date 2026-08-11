import { http, HttpResponse } from "msw";
import type {
  CustomConnectorHttpResponse,
  CustomConnectorMcpResponse,
  CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { ZeroMcpConnector } from "@vm0/api-contracts/contracts/zero-mcp-connectors";
import type { AgentCustomConnectorGrant } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";

export function customConnector(
  overrides: Partial<CustomConnectorHttpResponse> = {},
): CustomConnectorHttpResponse {
  return {
    kind: "http",
    id: "33333333-3333-4333-8333-333333333333",
    slug: "_acme-search",
    displayName: "Acme Search",
    prefixTemplates: ["https://api.acme.test/v1/"],
    fields: [
      {
        key: "apiKey",
        label: "API key",
        kind: "secret",
        required: true,
      },
    ],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{secrets.apiKey}}",
      },
    ],
    queryInjections: [],
    authMode: "manual",
    storageVersion: 1,
    connected: false,
    missingRequiredFields: ["apiKey"],
    configuredFieldKeys: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    hasSecret: false,
    ...overrides,
  };
}

export function mcpCustomConnector(
  overrides: Partial<CustomConnectorMcpResponse> = {},
): CustomConnectorMcpResponse {
  return {
    kind: "mcp",
    id: "44444444-4444-4444-8444-444444444444",
    slug: "_acme-mcp",
    displayName: "Acme MCP",
    endpoint: "https://mcp.example.test/server",
    transport: "streamable-http",
    prefixTemplates: [],
    permissionBundleRef: null,
    fields: [
      {
        key: "secret",
        label: "Secret",
        kind: "secret",
        required: true,
      },
    ],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{secrets.secret}}",
      },
    ],
    queryInjections: [],
    authMode: "manual",
    storageVersion: 1,
    connected: true,
    missingRequiredFields: [],
    configuredFieldKeys: ["secret"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    hasSecret: true,
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

export function runMcpConnector(
  overrides: Partial<ZeroMcpConnector> = {},
): ZeroMcpConnector {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    slug: "_acme-mcp",
    displayName: "Acme MCP",
    transport: "streamable-http",
    endpoint: "https://mcp.example.test/server",
    connected: true,
    ...overrides,
  };
}

export function stubRunMcpConnectors(
  connectors: readonly ZeroMcpConnector[],
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/zero/mcp-connectors`, () => {
    return HttpResponse.json({ connectors });
  });
}

export function stubRunMcpConnectorsUnavailable(
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/zero/mcp-connectors`, () => {
    return HttpResponse.json({ error: "Not found" }, { status: 404 });
  });
}

export function stubAgentCustomConnectors(
  grants: readonly AgentCustomConnectorGrant[],
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/zero/agents/:id/custom-connectors`, () => {
    return HttpResponse.json({ grants });
  });
}
