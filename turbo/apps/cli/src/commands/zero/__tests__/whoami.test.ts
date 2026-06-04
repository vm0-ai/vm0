import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { zeroWhoamiCommand } from "../whoami";

// Mock os.homedir to use temp directory for config isolation
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-zero-whoami-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      return TEST_HOME;
    },
  };
});

function buildJwt(payload: Record<string, unknown>, prefix: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = "test-signature";
  return `${prefix}${header}.${body}.${signature}`;
}

/**
 * Build a valid ZERO_TOKEN for testing.
 * Format: vm0_sandbox_<header>.<payload>.<signature>
 */
function buildZeroToken(payload: Record<string, unknown>): string {
  return buildJwt(payload, "vm0_sandbox_");
}

function buildCliToken(payload: Record<string, unknown>): string {
  return buildJwt(payload, "vm0_pat_");
}

function mockUserPermissionGrantsHandler(
  grants: Record<string, unknown>[] = [],
) {
  return http.get(
    "http://localhost:3000/api/zero/user-permission-grants",
    () => {
      return HttpResponse.json(grants);
    },
  );
}

function makePermissionGrant(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-123",
    connectorRef: "slack",
    permission: "channels:read",
    action: "allow",
    expiresAt: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("zero whoami command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(async () => {
    chalk.level = 0;

    // Ensure clean config state
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();

    // Clean up config
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  function getAllOutput(): string[] {
    return mockConsoleLog.mock.calls
      .map((call) => {
        return call[0] as string | undefined;
      })
      .filter((call): call is string => {
        return call !== undefined;
      });
  }

  async function runWhoami(args: string[] = []): Promise<void> {
    await zeroWhoamiCommand.parseAsync(["node", "cli", ...args]);
  }

  describe("sandbox mode (ZERO_AGENT_ID set)", () => {
    it("should show agent ID, run context, and capabilities with full JWT", async () => {
      const token = buildZeroToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "zero",
        capabilities: ["agent:read", "agent:write", "schedule:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("ZERO_AGENT_ID", "agent-123");
      vi.stubEnv("ZERO_TOKEN", token);

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Agent ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("agent-123");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Run ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("run-abc");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Org ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("org-xyz");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Capabilities:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("agent:read");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("schedule:read");
        }),
      ).toBe(true);
    });

    it("should show unavailable when ZERO_TOKEN is missing", async () => {
      vi.stubEnv("ZERO_AGENT_ID", "agent-no-token");

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Agent ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("agent-no-token");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Run ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("unavailable");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Capabilities:");
        }),
      ).toBe(false);
    });

    it("should show unavailable when ZERO_TOKEN is malformed", async () => {
      vi.stubEnv("ZERO_AGENT_ID", "agent-bad-token");
      vi.stubEnv("ZERO_TOKEN", "not-a-valid-token");

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("agent-bad-token");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("unavailable");
        }),
      ).toBe(true);
    });

    it("should show connected service identities", async () => {
      const token = buildZeroToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "zero",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("ZERO_AGENT_ID", "agent-123");
      vi.stubEnv("ZERO_TOKEN", token);
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");

      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "github",
                authMethod: "oauth",
                externalId: "12345",
                externalUsername: "octocat",
                externalEmail: "octocat@github.com",
                oauthScopes: ["repo"],
                needsReconnect: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
              {
                id: "2",
                type: "google",
                authMethod: "oauth",
                externalId: "67890",
                externalUsername: null,
                externalEmail: "user@gmail.com",
                oauthScopes: ["email"],
                needsReconnect: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            configuredTypes: ["github", "google"],
            connectorProvidedBindings: [],
          });
        }),
      );

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return (
            line.includes("@octocat") && line.includes("(octocat@github.com)")
          );
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("google") && line.includes("user@gmail.com");
        }),
      ).toBe(true);
    });

    it("should show needs reconnect warning", async () => {
      const token = buildZeroToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "zero",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("ZERO_AGENT_ID", "agent-123");
      vi.stubEnv("ZERO_TOKEN", token);
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");

      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "slack",
                authMethod: "oauth",
                externalId: "S123",
                externalUsername: "john.doe",
                externalEmail: null,
                oauthScopes: ["chat:write"],
                needsReconnect: true,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            configuredTypes: ["slack"],
            connectorProvidedBindings: [],
          });
        }),
      );

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return (
            line.includes("@john.doe") && line.includes("(needs reconnect)")
          );
        }),
      ).toBe(true);
    });

    it("should gracefully handle connector API error", async () => {
      const token = buildZeroToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "zero",
        capabilities: ["agent:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("ZERO_AGENT_ID", "agent-123");
      vi.stubEnv("ZERO_TOKEN", token);
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");

      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json(
            { error: { message: "Forbidden", code: "FORBIDDEN" } },
            { status: 403 },
          );
        }),
      );

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Agent ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("run-abc");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(false);
    });

    it("should skip connected services section when no connectors have identity", async () => {
      const token = buildZeroToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "zero",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("ZERO_AGENT_ID", "agent-123");
      vi.stubEnv("ZERO_TOKEN", token);
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");

      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({
            connectors: [],
            configuredTypes: [],
            connectorProvidedBindings: [],
          });
        }),
      );

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Agent ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(false);
    });

    it("should show identity without permission details by default", async () => {
      const token = buildZeroToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "zero",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("ZERO_AGENT_ID", "agent-123");
      vi.stubEnv("ZERO_TOKEN", token);
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");

      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "github",
                authMethod: "oauth",
                externalId: "12345",
                externalUsername: "octocat",
                externalEmail: "octocat@github.com",
                oauthScopes: ["repo"],
                needsReconnect: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            configuredTypes: ["github"],
            connectorProvidedBindings: [],
          });
        }),
      );

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return (
            line.includes("@octocat") && line.includes("(octocat@github.com)")
          );
        }),
      ).toBe(true);
      // No permission icons in default mode
      expect(
        output.some((line) => {
          return line.includes("✓") || line.includes("✗") || line.includes("?");
        }),
      ).toBe(false);
      expect(
        output.some((line) => {
          return line.includes("full access");
        }),
      ).toBe(false);
    });

    it("should show connector permissions with --permissions flag", async () => {
      const token = buildZeroToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "zero",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("ZERO_AGENT_ID", "agent-123");
      vi.stubEnv("ZERO_TOKEN", token);
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");

      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "slack",
                authMethod: "oauth",
                externalId: "S12345",
                externalUsername: "john.doe",
                externalEmail: "john@example.com",
                oauthScopes: ["chat:write"],
                needsReconnect: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            configuredTypes: ["slack"],
            connectorProvidedBindings: [],
          });
        }),
        mockUserPermissionGrantsHandler([
          makePermissionGrant({
            permission: "channels:read",
            action: "allow",
          }),
          makePermissionGrant({
            permission: "chat:write",
            action: "deny",
          }),
          makePermissionGrant({
            permission: "reactions:read",
            action: "allow",
          }),
        ]),
        http.get(
          "http://localhost:3000/api/zero/agents/agent-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["slack"] });
          },
        ),
      );

      await runWhoami(["--permissions"]);

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return (
            line.includes("@john.doe") && line.includes("(john@example.com)")
          );
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("✓") && line.includes("channels:read");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("✗") && line.includes("chat:write");
        }),
      ).toBe(true);
    });

    it("should show full access with --permissions for connector with null policies", async () => {
      const token = buildZeroToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "zero",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("ZERO_AGENT_ID", "agent-123");
      vi.stubEnv("ZERO_TOKEN", token);
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");

      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "github",
                authMethod: "oauth",
                externalId: "12345",
                externalUsername: "octocat",
                externalEmail: "octocat@github.com",
                oauthScopes: ["repo"],
                needsReconnect: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            configuredTypes: ["github"],
            connectorProvidedBindings: [],
          });
        }),
        mockUserPermissionGrantsHandler(),
        http.get(
          "http://localhost:3000/api/zero/agents/agent-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
      );

      await runWhoami(["--permissions"]);

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("@octocat");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("unknown endpoints");
        }),
      ).toBe(true);
    });

    it("should show identity only when permission grant API fails with --permissions", async () => {
      const token = buildZeroToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "zero",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("ZERO_AGENT_ID", "agent-123");
      vi.stubEnv("ZERO_TOKEN", token);
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");

      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "github",
                authMethod: "oauth",
                externalId: "12345",
                externalUsername: "octocat",
                externalEmail: "octocat@github.com",
                oauthScopes: ["repo"],
                needsReconnect: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            configuredTypes: ["github"],
            connectorProvidedBindings: [],
          });
        }),
        http.get(
          "http://localhost:3000/api/zero/user-permission-grants",
          () => {
            return HttpResponse.json(
              { error: { message: "Internal Server Error", code: "INTERNAL" } },
              { status: 500 },
            );
          },
        ),
        http.get(
          "http://localhost:3000/api/zero/agents/agent-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
      );

      await runWhoami(["--permissions"]);

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("@octocat");
        }),
      ).toBe(true);
      // No permission lines when grants are unavailable
      expect(
        output.some((line) => {
          return line.includes("✓") || line.includes("✗") || line.includes("?");
        }),
      ).toBe(false);
      expect(
        output.some((line) => {
          return line.includes("full access");
        }),
      ).toBe(false);
    });

    it("should show identity only when connector access API fails with --permissions", async () => {
      const token = buildZeroToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "zero",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("ZERO_AGENT_ID", "agent-123");
      vi.stubEnv("ZERO_TOKEN", token);
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");

      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "github",
                authMethod: "oauth",
                externalId: "12345",
                externalUsername: "octocat",
                externalEmail: "octocat@github.com",
                oauthScopes: ["repo"],
                needsReconnect: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            configuredTypes: ["github"],
            connectorProvidedBindings: [],
          });
        }),
        mockUserPermissionGrantsHandler([
          makePermissionGrant({
            connectorRef: "github",
            permission: "repo",
            action: "allow",
          }),
        ]),
        // user-connectors API fails
        http.get(
          "http://localhost:3000/api/zero/agents/agent-123/user-connectors",
          () => {
            return HttpResponse.json(
              { error: { message: "Forbidden", code: "FORBIDDEN" } },
              { status: 403 },
            );
          },
        ),
      );

      await runWhoami(["--permissions"]);

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("@octocat");
        }),
      ).toBe(true);
      // No permission lines when connector access data is unavailable
      expect(
        output.some((line) => {
          return line.includes("✓") || line.includes("✗") || line.includes("?");
        }),
      ).toBe(false);
      expect(
        output.some((line) => {
          return line.includes("full access");
        }),
      ).toBe(false);
    });

    it("should skip connectors without identity info", async () => {
      const token = buildZeroToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "zero",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("ZERO_AGENT_ID", "agent-123");
      vi.stubEnv("ZERO_TOKEN", token);
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");

      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "github",
                authMethod: "oauth",
                externalId: "12345",
                externalUsername: "octocat",
                externalEmail: "octocat@github.com",
                oauthScopes: ["repo"],
                needsReconnect: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
              {
                id: "2",
                type: "axiom",
                authMethod: "api-token",
                externalId: null,
                externalUsername: null,
                externalEmail: null,
                oauthScopes: null,
                needsReconnect: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            configuredTypes: ["github", "axiom"],
            connectorProvidedBindings: [],
          });
        }),
      );

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("@octocat");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("axiom");
        }),
      ).toBe(false);
    });
  });

  describe("local mode (no ZERO_AGENT_ID)", () => {
    it("should show authenticated via config file when token exists in config", async () => {
      const configDir = path.join(TEST_HOME, ".vm0");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ token: "test-token-config" }),
      );

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Authenticated");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("config file");
        }),
      ).toBe(true);
    });

    it("should show authenticated via ZERO_TOKEN env var", async () => {
      vi.stubEnv("ZERO_TOKEN", "env-token-test");

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Authenticated");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("ZERO_TOKEN env var");
        }),
      ).toBe(true);
    });

    it("should show not authenticated when no token exists", async () => {
      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Not authenticated");
        }),
      ).toBe(true);
    });

    it("should display active org from CLI JWT token", async () => {
      const cliJwt = buildCliToken({
        scope: "cli",
        orgId: "test-org-slug",
        userId: "user-1",
        tokenId: "tok-1",
      });
      vi.stubEnv("VM0_TOKEN", cliJwt);

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Org:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("test-org-slug");
        }),
      ).toBe(true);
    });
  });
});
