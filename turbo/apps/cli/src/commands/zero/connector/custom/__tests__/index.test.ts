import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomConnectorMcpResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { server } from "../../../../../mocks/server";
import { customConnector } from "../../../__tests__/helpers/custom-connectors";
import { customConnectorCommand } from "../index";

const CONNECTOR_ID = "33333333-3333-4333-8333-333333333333";

describe("zero connector custom readers", () => {
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-token");
  });

  afterEach(() => {
    consoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("normalizes an older kind-less HTTP list response", async () => {
    const connector = customConnector();
    server.use(
      http.get("http://localhost:3000/api/zero/custom-connectors", () => {
        return HttpResponse.json({
          connectors: [{ ...connector, kind: undefined }],
        });
      }),
    );

    await customConnectorCommand.parseAsync(["node", "zero", "list"]);

    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("KIND");
    expect(output).toContain("Acme Search");
    expect(output).toContain("http");
  });

  it("keeps HTTP routing details in status for an older kind-less response", async () => {
    const connector = customConnector();
    server.use(
      http.get(
        `http://localhost:3000/api/zero/custom-connectors/${CONNECTOR_ID}`,
        () => {
          return HttpResponse.json({ ...connector, kind: undefined });
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "zero",
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
      hasSecret: true,
    } satisfies CustomConnectorMcpResponse;
    server.use(
      http.get(
        `http://localhost:3000/api/zero/custom-connectors/${CONNECTOR_ID}`,
        () => {
          return HttpResponse.json(connector);
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "zero",
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
