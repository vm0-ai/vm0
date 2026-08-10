import { describe, expect, it } from "vitest";

import {
  createCustomConnectorBodySchema,
  updateCustomConnectorBodySchema,
} from "./zero-custom-connectors";

const manualFields = [
  {
    key: "secret",
    label: "API Token",
    kind: "secret" as const,
    required: true,
  },
];

const manualHeaders = [
  {
    name: "Authorization",
    valueTemplate: "Bearer {{secrets.secret}}",
  },
];

describe("Custom Connector writer contracts", () => {
  it("keeps kind-less HTTP input compatible", () => {
    const result = createCustomConnectorBodySchema.safeParse({
      displayName: "Legacy HTTP",
      prefixes: ["https://api.example.test/"],
      headerName: "Authorization",
      headerTemplate: "Bearer {{secret}}",
    });

    expect(result.success).toBeTruthy();
  });

  it("accepts only complete explicit MCP input", () => {
    const definition = {
      kind: "mcp",
      displayName: "Example MCP",
      endpoint: "https://mcp.example.test/server",
      transport: "streamable-http",
      fields: manualFields,
      headerInjections: manualHeaders,
      queryInjections: [],
      authMode: "manual",
    };

    expect(createCustomConnectorBodySchema.safeParse(definition).success).toBe(
      true,
    );
    expect(
      createCustomConnectorBodySchema.safeParse({
        ...definition,
        endpoint: undefined,
      }).success,
    ).toBe(false);
    expect(
      updateCustomConnectorBodySchema.safeParse({
        ...definition,
        prefixTemplates: ["https://api.example.test/"],
      }).success,
    ).toBe(false);
  });

  it("rejects MCP-owned fields on the HTTP branch", () => {
    expect(
      updateCustomConnectorBodySchema.safeParse({
        displayName: "Hybrid HTTP",
        endpoint: "https://mcp.example.test/server",
        transport: "streamable-http",
        prefixTemplates: ["https://api.example.test/"],
        fields: manualFields,
        headerInjections: manualHeaders,
        queryInjections: [],
        authMode: "manual",
      }).success,
    ).toBe(false);
  });
});
