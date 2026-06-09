/**
 * Tests for `zero automation webhook` commands (create / list / delete).
 *
 * Tests command-level behavior via parseAsync() following CLI testing
 * principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "../../../../../mocks/server";
import { webhookCommand } from "../index";
import chalk from "chalk";

const mockCompose = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "my-agent",
  headVersionId: "ver-001",
  content: null,
  createdAt: "2026-03-23T00:00:00Z",
  updatedAt: "2026-03-23T00:00:00Z",
};

const mockWebhookAutomation = {
  id: "11111111-1111-4111-8111-111111111111",
  agentId: "550e8400-e29b-41d4-a716-446655440000",
  userId: "user-001",
  name: "alerts",
  instruction: "Summarize the incoming alert",
  description: null,
  enabled: true,
  chatThreadId: "550e8400-e29b-41d4-a716-446655440099",
  webhookToken: "whk_deadbeef",
  webhookUrl: "http://localhost:3000/api/automations/webhooks/whk_deadbeef",
  createdAt: "2026-03-23T00:00:00Z",
  updatedAt: "2026-03-23T00:00:00Z",
};

const mockCreateResponse = {
  automation: mockWebhookAutomation,
  secret: "whsec_supersecretvalue",
};

function composeByNameHandler() {
  return http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get("name") !== "my-agent") {
      return HttpResponse.json(
        { error: { message: "Not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    return HttpResponse.json(mockCompose);
  });
}

describe("zero automation webhook command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("create", () => {
    it("should create a webhook automation and print URL + secret + curl", async () => {
      let capturedBody:
        | { name: string; instruction: string; agentId: string }
        | undefined;

      server.use(
        composeByNameHandler(),
        http.post(
          "http://localhost:3000/api/automations/webhooks",
          async ({ request }) => {
            capturedBody = (await request.json()) as {
              name: string;
              instruction: string;
              agentId: string;
            };
            return HttpResponse.json(mockCreateResponse, { status: 201 });
          },
        ),
      );

      await webhookCommand.parseAsync([
        "node",
        "cli",
        "create",
        "--agent-id",
        "my-agent",
        "--name",
        "alerts",
        "--prompt",
        "Summarize the incoming alert",
      ]);

      expect(capturedBody).toEqual({
        name: "alerts",
        instruction: "Summarize the incoming alert",
        agentId: "550e8400-e29b-41d4-a716-446655440000",
      });

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("created");
      // Inbound URL is surfaced.
      expect(logCalls).toContain(
        "http://localhost:3000/api/automations/webhooks/whk_deadbeef",
      );
      // Secret is shown once with guidance.
      expect(logCalls).toContain("shown once");
      expect(logCalls).toContain("whsec_supersecretvalue");
      // A signed curl example is printed against the right signature header.
      expect(logCalls).toContain("curl -X POST");
      expect(logCalls).toContain("x-vm0-signature-256");
      expect(logCalls).toContain("openssl dgst -sha256 -hmac");
    });

    it("should read the instruction from --prompt-file", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "webhook-prompt-"));
      const promptPath = join(tmpDir, "instruction.md");
      writeFileSync(promptPath, "instruction from file");

      let capturedInstruction: string | undefined;

      server.use(
        composeByNameHandler(),
        http.post(
          "http://localhost:3000/api/automations/webhooks",
          async ({ request }) => {
            const body = (await request.json()) as { instruction: string };
            capturedInstruction = body.instruction;
            return HttpResponse.json(mockCreateResponse, { status: 201 });
          },
        ),
      );

      try {
        await webhookCommand.parseAsync([
          "node",
          "cli",
          "create",
          "--agent-id",
          "my-agent",
          "--name",
          "alerts",
          "--prompt-file",
          promptPath,
        ]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }

      expect(capturedInstruction).toBe("instruction from file");
    });

    it("should emit raw JSON with the secret when --json is set", async () => {
      server.use(
        composeByNameHandler(),
        http.post("http://localhost:3000/api/automations/webhooks", () => {
          return HttpResponse.json(mockCreateResponse, { status: 201 });
        }),
      );

      await webhookCommand.parseAsync([
        "node",
        "cli",
        "create",
        "--agent-id",
        "my-agent",
        "--name",
        "alerts",
        "--prompt",
        "Summarize the incoming alert",
        "--json",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(logCalls);
      expect(parsed.secret).toBe("whsec_supersecretvalue");
      expect(parsed.automation.webhookUrl).toBe(
        "http://localhost:3000/api/automations/webhooks/whk_deadbeef",
      );
    });

    it("should reject combining --prompt and --prompt-file", async () => {
      server.use(composeByNameHandler());

      await expect(async () => {
        await webhookCommand.parseAsync([
          "node",
          "cli",
          "create",
          "--agent-id",
          "my-agent",
          "--name",
          "alerts",
          "--prompt",
          "inline",
          "--prompt-file",
          "/tmp/whatever.md",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Cannot use --prompt and --prompt-file together",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should error when the agent is not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await webhookCommand.parseAsync([
          "node",
          "cli",
          "create",
          "--agent-id",
          "missing",
          "--name",
          "alerts",
          "--prompt",
          "do it",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Agent not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should surface a not-found from the management API (switch off)", async () => {
      server.use(
        composeByNameHandler(),
        http.post("http://localhost:3000/api/automations/webhooks", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await webhookCommand.parseAsync([
          "node",
          "cli",
          "create",
          "--agent-id",
          "my-agent",
          "--name",
          "alerts",
          "--prompt",
          "do it",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("list", () => {
    it("should display webhook automations in table format", async () => {
      server.use(
        http.get("http://localhost:3000/api/automations/webhooks", () => {
          return HttpResponse.json({ automations: [mockWebhookAutomation] });
        }),
      );

      await webhookCommand.parseAsync(["node", "cli", "list"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("alerts");
      expect(logCalls).toContain("550e8400-e29b-41d4-a716-446655440000");
      expect(logCalls).toContain(
        "http://localhost:3000/api/automations/webhooks/whk_deadbeef",
      );
      expect(logCalls).toContain("enabled");
    });

    it("should display an empty state when there are none", async () => {
      server.use(
        http.get("http://localhost:3000/api/automations/webhooks", () => {
          return HttpResponse.json({ automations: [] });
        }),
      );

      await webhookCommand.parseAsync(["node", "cli", "list"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No webhook automations found");
      expect(logCalls).toContain("zero automation webhook create");
    });

    it("should print raw JSON when --json is set", async () => {
      server.use(
        http.get("http://localhost:3000/api/automations/webhooks", () => {
          return HttpResponse.json({ automations: [mockWebhookAutomation] });
        }),
      );

      await webhookCommand.parseAsync(["node", "cli", "list", "--json"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(logCalls);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("alerts");
      // The list projection never carries the secret.
      expect(parsed[0]).not.toHaveProperty("secret");
    });

    it("should handle an authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/automations/webhooks", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await webhookCommand.parseAsync(["node", "cli", "list"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("delete", () => {
    it("should delete by automation id", async () => {
      let deleteHitId: string | undefined;

      server.use(
        http.delete(
          "http://localhost:3000/api/automations/webhooks/:id",
          ({ params }) => {
            deleteHitId = params.id as string;
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );

      await webhookCommand.parseAsync([
        "node",
        "cli",
        "delete",
        "11111111-1111-4111-8111-111111111111",
      ]);

      expect(deleteHitId).toBe("11111111-1111-4111-8111-111111111111");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("deleted");
    });

    it("should handle a not-found automation", async () => {
      server.use(
        http.delete(
          "http://localhost:3000/api/automations/webhooks/:id",
          () => {
            return HttpResponse.json(
              { error: { message: "Not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
      );

      await expect(async () => {
        await webhookCommand.parseAsync([
          "node",
          "cli",
          "delete",
          "11111111-1111-4111-8111-111111111111",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
