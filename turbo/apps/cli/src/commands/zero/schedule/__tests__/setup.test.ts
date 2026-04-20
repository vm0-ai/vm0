/**
 * Tests for zero schedule setup command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "../../../../mocks/server";
import { setupCommand } from "../setup";
import chalk from "chalk";

const mockCompose = {
  id: "comp_abc123",
  name: "my-agent",
  headVersionId: "ver-001",
  content: null,
  createdAt: "2026-03-23T00:00:00Z",
  updatedAt: "2026-03-23T00:00:00Z",
};

const mockDeployResponse = {
  created: true,
  schedule: {
    id: "sched-001",
    agentId: "my-agent",
    userId: "user-001",
    name: "default",
    triggerType: "cron",
    cronExpression: "0 9 * * *",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "run daily check",
    description: null,
    appendSystemPrompt: null,
    vars: null,
    secretNames: null,
    volumeVersions: null,
    enabled: false,
    nextRunAt: "2026-03-24T09:00:00Z",
    lastRunAt: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    createdAt: "2026-03-23T00:00:00Z",
    updatedAt: "2026-03-23T00:00:00Z",
  },
};

describe("zero schedule setup command", () => {
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

  describe("successful setup (non-interactive)", () => {
    it("should create daily schedule with all flags", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") !== "my-agent") {
            return HttpResponse.json(
              { error: { message: "Not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          }
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
        http.post("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(mockDeployResponse, { status: 201 });
        }),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--frequency",
        "daily",
        "--time",
        "09:00",
        "--timezone",
        "UTC",
        "--prompt",
        "run daily check",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Schedule");
      expect(logCalls).toContain("created");
      expect(logCalls).toContain("my-agent");
    });

    it("should create loop schedule with interval flag", async () => {
      const loopResponse = {
        ...mockDeployResponse,
        schedule: {
          ...mockDeployResponse.schedule,
          triggerType: "loop",
          cronExpression: null,
          intervalSeconds: 300,
          nextRunAt: null,
        },
      };

      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") !== "my-agent") {
            return HttpResponse.json(
              { error: { message: "Not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          }
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
        http.post("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(loopResponse, { status: 201 });
        }),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--frequency",
        "loop",
        "--interval",
        "300",
        "--prompt",
        "loop task",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Schedule");
      expect(logCalls).toContain("created");
    });

    it("should create schedule when agent identifier is a UUID", async () => {
      const testUuid = "550e8400-e29b-41d4-a716-446655440000";
      const uuidCompose = { ...mockCompose, id: testUuid, name: "uuid-agent" };

      server.use(
        http.get(
          "http://localhost:3000/api/agent/composes/:id",
          ({ params }) => {
            if (params.id !== testUuid) {
              return HttpResponse.json(
                { error: { message: "Not found", code: "NOT_FOUND" } },
                { status: 404 },
              );
            }
            return HttpResponse.json(uuidCompose);
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
        http.post("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(mockDeployResponse, { status: 201 });
        }),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "--frequency",
        "daily",
        "--time",
        "09:00",
        "--timezone",
        "UTC",
        "--prompt",
        "run daily check",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Schedule");
      expect(logCalls).toContain("created");
    });
  });

  describe("prompt from file", () => {
    let tmpDir: string;
    let promptPath: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "schedule-prompt-"));
      promptPath = join(tmpDir, "prompt.md");
      writeFileSync(promptPath, "prompt loaded from file");
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should send file content as prompt when --prompt-file is used", async () => {
      let capturedPrompt: string | undefined;

      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") !== "my-agent") {
            return HttpResponse.json(
              { error: { message: "Not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          }
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            const body = (await request.json()) as { prompt: string };
            capturedPrompt = body.prompt;
            return HttpResponse.json(mockDeployResponse, { status: 201 });
          },
        ),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--frequency",
        "daily",
        "--time",
        "09:00",
        "--timezone",
        "UTC",
        "--prompt-file",
        promptPath,
      ]);

      expect(capturedPrompt).toBe("prompt loaded from file");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("created");
    });

    it("should reject combining --prompt and --prompt-file", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") !== "my-agent") {
            return HttpResponse.json(
              { error: { message: "Not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          }
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "my-agent",
          "--frequency",
          "daily",
          "--time",
          "09:00",
          "--timezone",
          "UTC",
          "--prompt",
          "inline prompt",
          "--prompt-file",
          promptPath,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Cannot use --prompt and --prompt-file together",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("help text", () => {
    it("should include notification guidance in notes", () => {
      // addHelpText content is not included in helpInformation(),
      // so we capture it via the help event
      let helpOutput = "";
      setupCommand.configureOutput({
        writeOut: (str: string) => {
          helpOutput += str;
        },
      });
      setupCommand.outputHelp();
      expect(helpOutput).toContain("notified when a schedule completes");
      expect(helpOutput).toContain("web chat or Slack");
    });
  });

  describe("error handling", () => {
    it("should handle agent not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Agent not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "missing",
          "--frequency",
          "daily",
          "--time",
          "09:00",
          "--prompt",
          "test",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --frequency in non-interactive mode", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") !== "my-agent") {
            return HttpResponse.json(
              { error: { message: "Not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          }
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "my-agent",
          "--prompt",
          "test",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--frequency is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
