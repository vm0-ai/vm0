import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../../mocks/server";
import { customConnector } from "../../../__tests__/helpers/custom-connectors";
import { createCustomConnectorCommand } from "../create";
import { customConnectorCommand } from "../index";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const CONNECTOR_ID = "33333333-3333-4333-8333-333333333333";

function buildZeroToken(capabilities: readonly string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      userId: "user-1",
      runId: "run-1",
      orgId: "org-1",
      scope: "zero",
      capabilities,
      iat: 1,
      exp: 2,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${payload}.test-signature`;
}

function agentResponse() {
  return {
    agentId: AGENT_ID,
    ownerId: "owner-1",
    description: null,
    displayName: "Connector Agent",
    sound: null,
    avatarUrl: null,
  };
}

describe("zero connector custom create", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  let tempDir: string;

  beforeEach(() => {
    chalk.level = 0;
    tempDir = mkdtempSync(join(tmpdir(), "zero-custom-connector-create-"));
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", buildZeroToken(["connector:write"]));
    vi.stubEnv("ZERO_AGENT_ID", "");
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

  it("creates, configures, and authorizes a manual connector", async () => {
    const definitionPath = writeDefinition({
      displayName: "Acme API",
      prefixTemplates: ["https://api.acme.example/v1/"],
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret",
          required: true,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.api_key}}",
        },
      ],
      queryInjections: [],
      authMode: "manual",
      values: [
        {
          key: "api_key",
          kind: "secret",
          value: "manual-secret",
        },
      ],
    });
    let createBody: unknown;
    let valuesBody: unknown;
    let agentBody: unknown;
    const created = customConnector({
      id: CONNECTOR_ID,
      displayName: "Acme API",
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret",
          required: true,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.api_key}}",
        },
      ],
      connected: false,
      missingRequiredFields: ["api_key"],
    });
    const configured = {
      ...created,
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["api_key"],
      hasSecret: true,
    };
    server.use(
      http.get(`http://localhost:3000/api/zero/agents/${AGENT_ID}`, () => {
        return HttpResponse.json(agentResponse());
      }),
      http.post(
        "http://localhost:3000/api/zero/custom-connectors",
        async ({ request }) => {
          createBody = await request.json();
          return HttpResponse.json(created, { status: 201 });
        },
      ),
      http.put(
        `http://localhost:3000/api/zero/custom-connectors/${CONNECTOR_ID}/values`,
        async ({ request }) => {
          valuesBody = await request.json();
          return HttpResponse.json(configured);
        },
      ),
      http.put(
        `http://localhost:3000/api/zero/agents/${AGENT_ID}/custom-connectors`,
        async ({ request }) => {
          agentBody = await request.json();
          return HttpResponse.json({ enabledIds: [CONNECTOR_ID] });
        },
      ),
    );
    vi.stubEnv("ZERO_AGENT_ID", AGENT_ID);

    await customConnectorCommand.parseAsync([
      "node",
      "zero",
      "create",
      "--file",
      definitionPath,
    ]);

    expect(createBody).toMatchObject({
      displayName: "Acme API",
      authMode: "manual",
    });
    expect(createBody).not.toHaveProperty("values");
    expect(valuesBody).toStrictEqual({
      values: [
        {
          key: "api_key",
          kind: "secret",
          value: "manual-secret",
        },
      ],
    });
    expect(agentBody).toStrictEqual({
      enabledIds: [CONNECTOR_ID],
      operation: "add",
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain('Custom connector "Acme API" created');
    expect(output).toContain("Authentication: manual");
    expect(output).toContain(`${AGENT_ID} (authorized)`);
    expect(output).not.toContain("manual-secret");
  });

  it("creates an OAuth connector and prints its user authorization link", async () => {
    const definitionPath = writeDefinition({
      displayName: "Acme OAuth API",
      prefixTemplates: ["https://{{variables.tenant}}.api.acme.example/v1/"],
      fields: [
        {
          key: "tenant",
          label: "Tenant",
          kind: "variable",
          required: true,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      authMode: "oauth",
      values: [{ key: "tenant", kind: "variable", value: "team-a" }],
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "oauth-client-id",
        clientSecret: "oauth-client-secret",
        authorizationUrl: "https://acme.example/oauth/authorize",
        tokenUrl: "https://acme.example/oauth/token",
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        scopes: ["read", "write"],
        authorizationParams: {},
      },
    });
    const authorizationUrl =
      "https://acme.example/oauth/authorize?state=oauth-state";
    let createBody: unknown;
    let valuesBody: unknown;
    let startBody: unknown;
    const created = customConnector({
      id: CONNECTOR_ID,
      displayName: "Acme OAuth API",
      authMode: "oauth",
      prefixTemplates: ["https://{{variables.tenant}}.api.acme.example/v1/"],
      fields: [
        {
          key: "tenant",
          label: "Tenant",
          kind: "variable",
          required: true,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      missingRequiredFields: ["tenant", "oauth"],
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "oauth-client-id",
        authorizationUrl: "https://acme.example/oauth/authorize",
        tokenUrl: "https://acme.example/oauth/token",
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        scopes: ["read", "write"],
        authorizationParams: {},
      },
    });
    const configured = {
      ...created,
      configuredFieldKeys: ["tenant"],
      missingRequiredFields: ["oauth"],
    };
    server.use(
      http.get(`http://localhost:3000/api/zero/agents/${AGENT_ID}`, () => {
        return HttpResponse.json(agentResponse());
      }),
      http.post(
        "http://localhost:3000/api/zero/custom-connectors",
        async ({ request }) => {
          createBody = await request.json();
          return HttpResponse.json(created, { status: 201 });
        },
      ),
      http.put(
        `http://localhost:3000/api/zero/custom-connectors/${CONNECTOR_ID}/values`,
        async ({ request }) => {
          valuesBody = await request.json();
          return HttpResponse.json(configured);
        },
      ),
      http.post(
        `http://localhost:3000/api/zero/custom-connectors/${CONNECTOR_ID}/oauth2/start`,
        async ({ request }) => {
          startBody = await request.json();
          return HttpResponse.json({ authorizationUrl });
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "zero",
      "create",
      "--file",
      definitionPath,
      "--agent",
      AGENT_ID,
    ]);

    expect(createBody).toMatchObject({
      displayName: "Acme OAuth API",
      authMode: "oauth",
      oauthConfig: {
        clientId: "oauth-client-id",
        clientSecret: "oauth-client-secret",
      },
    });
    expect(createBody).not.toHaveProperty("values");
    expect(valuesBody).toStrictEqual({
      values: [{ key: "tenant", kind: "variable", value: "team-a" }],
    });
    expect(startBody).toStrictEqual({ agentId: AGENT_ID });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain('Custom connector "Acme OAuth API" created');
    expect(output).toContain("Authentication: oauth");
    expect(output).toContain(`[Authorize Acme OAuth API](${authorizationUrl})`);
    expect(output).toContain(`authorize this connector for agent ${AGENT_ID}`);
    expect(output).not.toContain("oauth-client-secret");
  });

  it("rejects an agent run without custom connector write access", async () => {
    const definitionPath = writeDefinition({});
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });
    vi.stubEnv("ZERO_TOKEN", buildZeroToken(["connector:read"]));

    try {
      await customConnectorCommand.parseAsync([
        "node",
        "zero",
        "create",
        "--file",
        definitionPath,
      ]);

      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
        "Custom connector creation is not enabled for this agent run",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      mockConsoleError.mockRestore();
      mockExit.mockRestore();
    }
  });

  it("documents both file formats and no longer exposes propose", () => {
    let help = "";
    createCustomConnectorCommand.configureOutput({
      writeOut: (value) => {
        help += value;
      },
    });
    createCustomConnectorCommand.outputHelp();

    expect(help).toContain("Manual mode:");
    expect(help).toContain(
      "The user should not need to write JSON or run this command.",
    );
    expect(help).toContain('"authMode": "manual"');
    expect(help).toContain("{{secrets.KEY}}");
    expect(help).toContain("OAuth mode:");
    expect(help).toContain('"authMode": "oauth"');
    expect(help).toContain('"values": []');
    expect(help).toContain("{{oauth.access_token}}");
    expect(help).toContain("customConnectorCliCreate");
    expect(help).toContain("plaintext credentials");
    expect(
      customConnectorCommand.commands.map((command) => {
        return command.name();
      }),
    ).toStrictEqual(["create", "list", "status"]);
  });
});
