import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomConnectorMcpResponse } from "@okouai/api-contracts/contracts/custom-connectors";

import { server } from "../../../../mocks/server";
import {
  customConnector,
  stubAgentCustomConnectors,
  stubCustomConnectors,
} from "../../../__tests__/helpers/custom-connectors";
import { customConnectorCommand } from "../index";

const CONNECTOR_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";

describe("okou connector custom readers", () => {
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
  });

  afterEach(() => {
    consoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("renders tagged HTTP connectors in list output", async () => {
    const connector = customConnector();
    server.use(
      http.get("http://localhost:3000/api/custom-connectors", () => {
        return HttpResponse.json({
          connectors: [connector],
        });
      }),
    );

    await customConnectorCommand.parseAsync(["node", "okou", "list"]);

    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("KIND");
    expect(output).toContain("Acme Search");
    expect(output).toContain("http");
  });

  it("renders grant-based authorization for an agent", async () => {
    const connector = customConnector();
    server.use(
      stubCustomConnectors([connector]),
      http.get(`http://localhost:3000/api/agents/${AGENT_ID}`, () => {
        return HttpResponse.json({
          agentId: AGENT_ID,
          ownerId: "owner-1",
          description: null,
          displayName: "Maya",
          sound: null,
          avatarUrl: null,
        });
      }),
      stubAgentCustomConnectors([
        {
          customConnectorId: connector.id,
          permissionNames: ["chat:write"],
        },
      ]),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "list",
      "--agent",
      AGENT_ID,
    ]);

    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("AUTHORIZED FOR Maya");
    const connectorRow = (consoleLog.mock.calls.flat() as string[]).find(
      (line) => {
        return line.startsWith(connector.id);
      },
    );
    expect(connectorRow).toMatch(/✓$/u);
  });

  it("shows tagged HTTP routing details in status", async () => {
    const connector = customConnector();
    server.use(
      http.get(
        `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
        () => {
          return HttpResponse.json(connector);
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "status",
      CONNECTOR_ID,
    ]);

    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Kind:             http");
    expect(output).toContain("Prefixes:         https://api.acme.test/v1/");
  });

  it("shows an MCP connector endpoint without HTTP routing fields", async () => {
    const connector = {
      kind: "mcp",
      id: CONNECTOR_ID,
      slug: "_acme-mcp",
      displayName: "Acme MCP",
      endpoint: "https://mcp.acme.test/server",
      transport: "streamable-http",
      prefixTemplates: [],
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
      permissionBundleRef: null,
      storageVersion: 1,
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    } satisfies CustomConnectorMcpResponse;
    server.use(
      http.get(
        `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
        () => {
          return HttpResponse.json(connector);
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "status",
      CONNECTOR_ID,
    ]);

    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Kind:             mcp");
    expect(output).toContain("Transport:        streamable-http");
    expect(output).toContain("Endpoint:         https://mcp.acme.test/server");
    expect(output).not.toContain("Prefixes:");
  });
});
