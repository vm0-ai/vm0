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

function definition() {
  return {
    displayName: "Acme API",
    prefixTemplates: ["https://api.acme.example/v1/"],
    fields: [
      {
        key: "api_token",
        label: "API Token",
        kind: "secret",
        required: true,
        description: "API credential",
      },
    ],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{secrets.api_token}}",
      },
    ],
    queryInjections: [],
    authMode: "manual",
  } as const;
}

describe("zero connector custom create", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  let tempDir: string;

  beforeEach(() => {
    chalk.level = 0;
    tempDir = mkdtempSync(join(tmpdir(), "zero-custom-connector-create-"));
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", buildZeroToken(["connector:write"]));
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

  it("creates only the API connector definition", async () => {
    const definitionPath = writeDefinition(definition());
    let createBody: unknown;
    const created = customConnector({
      id: CONNECTOR_ID,
      displayName: "Acme API",
      prefixTemplates: ["https://api.acme.example/v1/"],
      fields: [...definition().fields],
      headerInjections: [...definition().headerInjections],
      missingRequiredFields: ["api_token"],
    });
    server.use(
      http.post(
        "http://localhost:3000/api/zero/custom-connectors",
        async ({ request }) => {
          createBody = await request.json();
          return HttpResponse.json(created, { status: 201 });
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "zero",
      "create",
      "--file",
      definitionPath,
    ]);

    expect(createBody).toStrictEqual(definition());
    expect(createBody).not.toHaveProperty("values");
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain('Custom connector "Acme API" created');
    expect(output).toContain("awaiting connection");
    expect(output).toContain("Connectors page to enter the credential");
  });

  it("rejects files containing credential values", async () => {
    const definitionPath = writeDefinition({
      ...definition(),
      values: [{ key: "api_token", kind: "secret", value: "plaintext-secret" }],
    });
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });

    try {
      await customConnectorCommand.parseAsync([
        "node",
        "zero",
        "create",
        "--file",
        definitionPath,
      ]);

      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
        "Unrecognized key",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    } finally {
      mockConsoleError.mockRestore();
      mockExit.mockRestore();
    }
  });

  it("rejects an agent run without custom connector write access", async () => {
    const definitionPath = writeDefinition(definition());
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

  it("documents definition-only creation without requesting credentials", () => {
    let createHelp = "";
    createCustomConnectorCommand.configureOutput({
      writeOut: (value) => {
        createHelp += value;
      },
    });
    createCustomConnectorCommand.outputHelp();

    expect(createHelp).toContain("Never include an API token");
    expect(createHelp).toContain(
      "Do not ask the user for the actual API token",
    );
    expect(createHelp).toContain("<API Token>");
    expect(createHelp).toContain("Bearer {{secrets.api_token}}");
    expect(createHelp).toContain("actual credential later");
    expect(createHelp).toContain("OAuth custom connectors must be created");

    let customHelp = "";
    customConnectorCommand.configureOutput({
      writeOut: (value) => {
        customHelp += value;
      },
    });
    customConnectorCommand.outputHelp();
    expect(customHelp).toContain("zero connector custom create -h");
    expect(
      customConnectorCommand.commands.map((command) => {
        return command.name();
      }),
    ).toStrictEqual(["create", "list", "status"]);
  });
});
