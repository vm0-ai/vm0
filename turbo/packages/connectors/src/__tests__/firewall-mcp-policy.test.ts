import { describe, expect, it } from "vitest";

import { firewallApiSchema } from "../firewall-types";

const validMcpApi = {
  base: "https://mcp.example.com/v1/mcp",
  hostPolicy: { kind: "publicDestination" },
  auth: {},
  mcp: {
    toolPolicy: {
      kind: "exact",
      toolNames: ["search", "calendar.create"],
    },
  },
  suppressBodyCapture: true,
} as const;

describe("MCP firewall API contract", () => {
  it("accepts static no-auth public HTTPS endpoints and explicit tool policy", () => {
    expect(firewallApiSchema.safeParse(validMcpApi).success).toBe(true);
    expect(
      firewallApiSchema.safeParse({
        ...validMcpApi,
        auth: { headers: {}, query: {} },
        mcp: { toolPolicy: { kind: "all" } },
      }).success,
    ).toBe(true);
  });

  it.each([
    { base: "http://mcp.example.com/v1/mcp" },
    { base: "https://mcp.example.com/v1/mcp?tenant=1" },
    { base: "https://${{ vars.HOST }}/v1/mcp" },
    { hostPolicy: { kind: "providerOwned", exactHosts: ["mcp.example.com"] } },
    { auth: { headers: { Authorization: "Bearer token" } } },
    { suppressBodyCapture: undefined },
    {
      mcp: {
        toolPolicy: {
          kind: "exact",
          toolNames: ["search", "search"],
        },
      },
    },
  ])("rejects an unsafe MCP API entry: %j", (override) => {
    expect(
      firewallApiSchema.safeParse({ ...validMcpApi, ...override }).success,
    ).toBe(false);
  });
});
