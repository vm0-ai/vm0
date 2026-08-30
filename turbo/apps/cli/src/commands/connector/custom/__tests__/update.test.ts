import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { customConnectorCommand } from "../index";
import { updateCustomConnectorCommand } from "../update";

const CONNECTOR_ID = "33333333-3333-4333-8333-333333333333";

function buildOkouToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      userId: "user-1",
      runId: "run-1",
      orgId: "org-1",
      scope: "okou",
      capabilities: ["connector:write"],
      iat: 1,
      exp: 2,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${payload}.test-signature`;
}

function manualMcpDefinition() {
  return {
    kind: "mcp",
    displayName: "Acme MCP Updated",
    endpoint: "https://mcp.acme.example/v2/server",
    transport: "streamable-http",
    fields: [
      {
        key: "secret",
        label: "API Token",
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
  } as const;
}

function oauthMcpDefinition() {
  return {
    kind: "mcp",
    displayName: "Acme OAuth MCP Updated",
    endpoint: "https://oauth-mcp.acme.example/server",
    transport: "streamable-http",
    fields: [],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{oauth.access_token}}",
      },
    ],
    queryInjections: [],
    authMode: "oauth",
    oauthConfig: {
      providerAdapter: "standard",
      clientId: "oauth-client-id",
      authorizationUrl: "https://acme.example/oauth/authorize",
      tokenUrl: "https://acme.example/oauth/token",
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: ["read"],
      authorizationParams: {},
    },
  } as const;
}

function mcpResponse(definition: ReturnType<typeof manualMcpDefinition>) {
  return {
    kind: "mcp" as const,
    id: CONNECTOR_ID,
    slug: "_acme-mcp",
    displayName: definition.displayName,
    endpoint: definition.endpoint,
    transport: "streamable-http" as const,
    prefixTemplates: [] as const,
    fields: [...definition.fields],
    headerInjections: [...definition.headerInjections],
    queryInjections: [],
    authMode: definition.authMode,
    permissionBundleRef: null,
    storageVersion: 1,
    connected: true,
    missingRequiredFields: [],
    configuredFieldKeys: ["secret"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("okou connector custom update", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  let tempDir: string;

  beforeEach(() => {
    chalk.level = 0;
    tempDir = mkdtempSync(join(tmpdir(), "custom-connector-update-"));
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", buildOkouToken());
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeDefinition(value: unknown): string {
    const path = join(tempDir, "connector.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  it("updates an MCP definition with the exact file body", async () => {
    const definition = manualMcpDefinition();
    const definitionPath = writeDefinition(definition);
    let updateBody: unknown;
    server.use(
      http.put(
        `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
        async ({ request }) => {
          updateBody = await request.json();
          return HttpResponse.json(mcpResponse(definition));
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "update",
      CONNECTOR_ID,
      "--file",
      definitionPath,
    ]);

    expect(updateBody).toStrictEqual(definition);
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      'Custom connector "Acme MCP Updated" updated',
    );
  });

  it("allows an OAuth update to omit the current client secret", async () => {
    const definition = oauthMcpDefinition();
    const definitionPath = writeDefinition(definition);
    let updateBody: unknown;
    server.use(
      http.put(
        `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
        async ({ request }) => {
          updateBody = await request.json();
          return HttpResponse.json({
            ...mcpResponse(manualMcpDefinition()),
            displayName: definition.displayName,
            endpoint: definition.endpoint,
            fields: [],
            headerInjections: [...definition.headerInjections],
            authMode: "oauth",
            oauthConfig: definition.oauthConfig,
            configuredFieldKeys: [],
          });
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "update",
      CONNECTOR_ID,
      "--file",
      definitionPath,
      "--json",
    ]);

    expect(updateBody).toStrictEqual(definition);
    expect(updateBody).not.toHaveProperty("oauthConfig.clientSecret");
  });

  it("rejects hybrid protocol files before making a request", async () => {
    const definitionPath = writeDefinition({
      ...manualMcpDefinition(),
      prefixTemplates: ["https://api.acme.example/"],
    });
    let requests = 0;
    server.use(
      http.put(
        `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
        () => {
          requests += 1;
          return HttpResponse.json({}, { status: 500 });
        },
      ),
    );
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });

    try {
      await customConnectorCommand.parseAsync([
        "node",
        "okou",
        "update",
        CONNECTOR_ID,
        "--file",
        definitionPath,
      ]);

      expect(requests).toBe(0);
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      mockConsoleError.mockRestore();
      mockExit.mockRestore();
    }
  });

  it("documents OAuth secret preservation", () => {
    let help = "";
    updateCustomConnectorCommand.configureOutput({
      writeOut: (value) => {
        help += value;
      },
    });
    updateCustomConnectorCommand.outputHelp();

    expect(help).toContain("may omit oauthConfig.clientSecret");
    expect(help).toContain("Never include an end-user token");
  });
});
