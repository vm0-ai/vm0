/**
 * Tests for zero doctor check-connector command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, connector mappings from @vm0/core
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { checkConnectorCommand } from "../check-connector";
import chalk from "chalk";

/** Build a fake ZERO_TOKEN JWT with the given payload fields. */
function buildZeroToken(
  overrides: Partial<{
    userId: string;
    runId: string;
    orgId: string;
    scope: string;
    capabilities: string[];
  }> = {},
): string {
  const payload = {
    userId: "user-1",
    runId: "run-abc-123",
    orgId: "org-1",
    scope: "zero",
    capabilities: ["agent-run:read"],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

/** Minimal valid connector response for MSW handlers */
const connectedResponse = {
  id: "conn-1",
  type: "github",
  authMethod: "oauth",
  externalId: "ext-1",
  externalUsername: "user",
  externalEmail: "user@example.com",
  oauthScopes: ["repo"],
  needsReconnect: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** Minimal run context response */
const runContextResponse = {
  prompt: "test",
  appendSystemPrompt: null,
  sessionId: null,
  secretNames: [],
  vars: null,
  environment: {},
  firewalls: [
    {
      name: "github",
      apis: [
        {
          base: "https://api.github.com",
          permissions: [],
        },
        {
          base: "https://uploads.github.com",
          permissions: [],
        },
      ],
    },
  ],
  networkPolicies: {
    github: {
      allow: ["contents:read"],
      deny: ["admin"],
      ask: ["actions:write"],
      unknownPolicy: "allow" as const,
    },
  },
  volumes: [],
  artifact: null,
  memory: null,
  featureFlags: null,
};

describe("zero doctor check-connector command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("GH_TOKEN", "");
  });

  function getOutput(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  describe("step 1: sandbox environment variable check", () => {
    it("should report env var present when it exists", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("GH_TOKEN", "ghp_test123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(connectedResponse);
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      const output = getOutput();
      expect(output).toContain("present");
      expect(output).toContain("placeholder value");
    });

    it("should report env var not present when it is missing", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: [] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      const output = getOutput();
      expect(output).toContain("not present");
    });
  });

  describe("step 2: connector status", () => {
    it("should report connector not connected with connect URL", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: [] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      const output = getOutput();
      expect(output).toContain("not connected");
      expect(output).toContain(
        "[Connect GitHub](https://app.vm0.ai/connectors/github/connect?agentId=agent-abc-123)",
      );
    });

    it("should report connector expired with reconnect URL", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json({
            ...connectedResponse,
            needsReconnect: true,
          });
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      const output = getOutput();
      expect(output).toContain("expired");
      expect(output).toContain("needs to be reconnected");
      expect(output).toContain(
        "[Reconnect GitHub](https://app.vm0.ai/connectors)",
      );
    });

    it("should report connector not authorized with authorize URL", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(connectedResponse);
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["slack"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      const output = getOutput();
      expect(output).toContain("not authorized");
      expect(output).toContain(
        "[Authorize GitHub](https://app.vm0.ai/connectors/github/authorize?agentId=agent-abc-123)",
      );
    });

    it("should report connector connected and active when healthy", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(connectedResponse);
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      const output = getOutput();
      expect(output).toContain("connected and active");
      expect(output).toContain("authorized for this agent");
    });
  });

  describe("step 2c: registered base URLs", () => {
    it("should list configured domains from run context", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(connectedResponse);
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      const output = getOutput();
      expect(output).toContain("https://api.github.com");
      expect(output).toContain("https://uploads.github.com");
      expect(output).toContain(
        "configured for this run with the following base URLs:",
      );
    });

    it("should report no firewall entry when connector not in run", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(connectedResponse);
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json({ ...runContextResponse, firewalls: [] });
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      const output = getOutput();
      expect(output).toContain("No configuration found");
    });
  });

  describe("step 3: permission policy check", () => {
    it("should report permission in allow list", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(connectedResponse);
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
        "--check-permission",
        "contents:read",
      ]);

      const output = getOutput();
      expect(output).toContain("Step 3: Permission policy check");
      expect(output).toContain('"contents:read" is in the allow list');
    });

    it("should report permission in deny list", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(connectedResponse);
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
        "--check-permission",
        "admin",
      ]);

      const output = getOutput();
      expect(output).toContain('"admin" is in the deny list');
    });

    it("should report unmatched permission falling through to unknown policy", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(connectedResponse);
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
        "--check-permission",
        "some-unknown-perm",
      ]);

      const output = getOutput();
      expect(output).toContain(
        '"some-unknown-perm" is not in any permission list',
      );
      expect(output).toContain("unknown endpoint policy: allow");
    });
  });

  describe("URL transformation", () => {
    it("should transform www.vm0.ai to app.vm0.ai", async () => {
      vi.stubEnv("VM0_API_URL", "https://www.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://www.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.get(
          "https://www.vm0.ai/api/zero/agents/agent-1/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: [] });
          },
        ),
        http.get("https://www.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      const output = getOutput();
      expect(output).toContain(
        "https://app.vm0.ai/connectors/github/connect?agentId=agent-1",
      );
    });
  });

  describe("unknown env var", () => {
    it("should exit with error for unrecognized env var", async () => {
      await expect(async () => {
        await checkConnectorCommand.parseAsync([
          "node",
          "cli",
          "--env-name",
          "UNKNOWN_FOO_TOKEN",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Unknown environment variable: UNKNOWN_FOO_TOKEN",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("re-diagnose hint", () => {
    it("should include re-diagnose hint with check-connector syntax", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(connectedResponse);
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      const output = getOutput();
      expect(output).toContain(
        "zero doctor check-connector --env-name GH_TOKEN",
      );
    });

    it("should include --check-permission in re-diagnose hint when used", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(connectedResponse);
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
        "--check-permission",
        "contents:read",
      ]);

      const output = getOutput();
      expect(output).toContain(
        "zero doctor check-connector --env-name GH_TOKEN --check-permission contents:read",
      );
    });
  });

  describe("--url mode", () => {
    it("should resolve connector from URL and run full diagnostic", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(connectedResponse);
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--url",
        "https://api.github.com/repos/owner/repo",
      ]);

      const output = getOutput();
      expect(output).toContain("matches the GitHub connector");
      expect(output).toContain("Matched base URL: https://api.github.com");
      expect(output).toContain("Relative path:    /repos/owner/repo");
      expect(output).toContain("Step 1: Sandbox environment variable");
      expect(output).toContain("Step 2: Connector configuration");
      expect(output).toContain(
        "Step 3: Permission policy check (auto-detected from URL)",
      );
      expect(output).toContain(
        "zero doctor check-connector --url https://api.github.com/repos/owner/repo",
      );
    });

    it("should fail for unrecognized URL", async () => {
      await expect(async () => {
        await checkConnectorCommand.parseAsync([
          "node",
          "cli",
          "--url",
          "https://unknown-service.example.com/path",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No connector found for URL"),
      );
    });

    it("should include --method in re-diagnose hint when not GET", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      vi.stubEnv("ZERO_TOKEN", buildZeroToken());
      server.use(
        http.get("https://app.vm0.ai/api/zero/connectors/github", () => {
          return HttpResponse.json(connectedResponse);
        }),
        http.get(
          "https://app.vm0.ai/api/zero/agents/agent-abc-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
        http.get("https://app.vm0.ai/api/zero/runs/run-abc-123/context", () => {
          return HttpResponse.json(runContextResponse);
        }),
      );

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--url",
        "https://api.github.com/repos/owner/repo",
        "--method",
        "POST",
      ]);

      const output = getOutput();
      expect(output).toContain(
        "zero doctor check-connector --url https://api.github.com/repos/owner/repo --method POST",
      );
    });
  });
});
