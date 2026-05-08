import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createMockChildProcess } from "../../../mocks/spawn-helpers";
import { runCommand } from "../index";
import chalk from "chalk";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import * as os from "os";

// Mock child_process.spawn since it's an external system call boundary
vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return {
    ...original,
    spawn: vi.fn(),
  };
});

import { spawn } from "child_process";
const mockSpawn = vi.mocked(spawn);

describe("run command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  const testUuid = "550e8400-e29b-41d4-a716-446655440000";

  // Default compose response for getComposeById
  const defaultComposeResponse = {
    id: testUuid,
    name: "test-agent",
    headVersionId: "version-123",
    content: {
      version: "1",
      agents: { "test-agent": { provider: "claude" } },
    },
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };

  // Default run response
  const defaultRunResponse = {
    runId: "run-123",
    status: "running",
    sandboxId: "sbx-456",
    output: "Success",
    executionTimeMs: 1000,
    createdAt: "2025-01-01T00:00:00Z",
  };

  // Default events response with completed status
  const defaultEventsResponse = {
    events: [
      {
        sequenceNumber: 0,
        eventType: "result",
        eventData: {
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1000,
          num_turns: 1,
          result: "Done",
          session_id: "test",
          total_cost_usd: 0,
          usage: {},
        },
        createdAt: "2025-01-01T00:00:00Z",
      },
    ],
    hasMore: false,
    nextSequence: 0,
    run: { status: "completed" },
    framework: "claude-code",
  };

  beforeEach(() => {
    // Disable chalk colors for deterministic console output assertions
    chalk.level = 0;
    // Use environment variables for config instead of mocking the module
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    // Default handlers for most tests
    server.use(
      http.get("http://localhost:3000/api/agent/composes/:id", () => {
        return HttpResponse.json(defaultComposeResponse);
      }),
      http.post("http://localhost:3000/api/agent/runs", () => {
        return HttpResponse.json(defaultRunResponse, { status: 201 });
      }),
      http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
        return HttpResponse.json(defaultEventsResponse);
      }),
      // Default org handler
      http.get("http://localhost:3000/api/org", () => {
        return HttpResponse.json({
          id: "org-123",
          slug: "test-user",
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
        });
      }),
      // Default npm registry handler - return same version to skip upgrade
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "0.0.0-test" });
      }),
    );

    // Default spawn mock - succeeds immediately
    mockSpawn.mockImplementation(() => {
      return createMockChildProcess(0) as never;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("composeId validation", () => {
    it("should accept valid UUID format", async () => {
      let capturedBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      expect(capturedBody).toEqual({
        agentComposeId: testUuid,
        prompt: "test prompt",
        vars: undefined,
        secrets: undefined,
        volumeVersions: undefined,
        conversationId: undefined,
      });
    });

    it("should accept and resolve agent names", async () => {
      let capturedBody: unknown;
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "my-agent") {
            return HttpResponse.json({
              id: testUuid,
              name: "my-agent",
              headVersionId: "version-123",
              content: {
                version: "1",
                agents: { "my-agent": { provider: "claude" } },
              },
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-01T00:00:00Z",
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync(["node", "cli", "my-agent", "test prompt"]);

      expect(capturedBody).toEqual({
        agentComposeId: testUuid,
        prompt: "test prompt",
        vars: undefined,
        secrets: undefined,
        volumeVersions: undefined,
        conversationId: undefined,
      });
    });

    it("should handle agent not found errors", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Compose not found: nonexistent-agent",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "nonexistent-agent",
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Agent not found: nonexistent-agent"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 compose"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should parse name:version format and call getComposeVersion", async () => {
      let capturedBody: unknown;
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "my-agent") {
            return HttpResponse.json({
              id: "550e8400-e29b-41d4-a716-446655440000",
              name: "my-agent",
              headVersionId:
                "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
              content: {
                version: "1",
                agents: { main: { provider: "claude" } },
              },
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-01T00:00:00Z",
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.get(
          "http://localhost:3000/api/agent/composes/versions",
          ({ request }) => {
            const url = new URL(request.url);
            if (
              url.searchParams.get("composeId") ===
                "550e8400-e29b-41d4-a716-446655440000" &&
              url.searchParams.get("version") === "abc12345"
            ) {
              return HttpResponse.json({
                versionId:
                  "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
              });
            }
            return HttpResponse.json(
              { error: { message: "Version not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "my-agent:abc12345",
        "test prompt",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          agentComposeVersionId:
            "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
        }),
      );
    });

    it("should use agentComposeId for :latest version", async () => {
      let capturedBody: unknown;
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "my-agent") {
            return HttpResponse.json({
              id: "550e8400-e29b-41d4-a716-446655440000",
              name: "my-agent",
              headVersionId:
                "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
              content: {
                version: "1",
                agents: { main: { provider: "claude" } },
              },
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-01T00:00:00Z",
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "my-agent:latest",
        "test prompt",
      ]);

      // Should use agentComposeId (not agentComposeVersionId)
      expect(capturedBody).toEqual(
        expect.objectContaining({
          agentComposeId: "550e8400-e29b-41d4-a716-446655440000",
        }),
      );
    });

    it("should handle version not found error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "my-agent") {
            return HttpResponse.json({
              id: "550e8400-e29b-41d4-a716-446655440000",
              name: "my-agent",
              headVersionId:
                "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
              content: {
                version: "1",
                agents: { main: { provider: "claude" } },
              },
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-01T00:00:00Z",
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.get("http://localhost:3000/api/agent/composes/versions", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Version 'deadbeef' not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "my-agent:deadbeef",
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Version not found: deadbeef"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should treat slash in identifier as part of name", async () => {
      let capturedQueryParams: { name: string | null } | undefined;
      let capturedBody: unknown;
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          capturedQueryParams = {
            name: url.searchParams.get("name"),
          };
          return HttpResponse.json({
            id: "550e8400-e29b-41d4-a716-446655440000",
            name: "user-abc123/my-agent",
            headVersionId:
              "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
            content: { version: "1", agents: { main: { provider: "claude" } } },
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          });
        }),
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "user-abc123/my-agent",
        "test prompt",
      ]);

      expect(capturedQueryParams).toEqual({
        name: "user-abc123/my-agent",
      });
      expect(capturedBody).toEqual(
        expect.objectContaining({
          agentComposeId: "550e8400-e29b-41d4-a716-446655440000",
        }),
      );
    });

    it("should parse org/name:version format", async () => {
      let capturedVersionParams:
        | { composeId: string | null; version: string | null }
        | undefined;
      let capturedBody: unknown;
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            id: "550e8400-e29b-41d4-a716-446655440000",
            name: "my-agent",
            headVersionId:
              "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
            content: { version: "1", agents: { main: { provider: "claude" } } },
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          });
        }),
        http.get(
          "http://localhost:3000/api/agent/composes/versions",
          ({ request }) => {
            const url = new URL(request.url);
            capturedVersionParams = {
              composeId: url.searchParams.get("composeId"),
              version: url.searchParams.get("version"),
            };
            return HttpResponse.json({
              versionId:
                "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
            });
          },
        ),
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "user-abc123/my-agent:abc12345",
        "test prompt",
      ]);

      expect(capturedVersionParams).toEqual({
        composeId: "550e8400-e29b-41d4-a716-446655440000",
        version: "abc12345",
      });
      expect(capturedBody).toEqual(
        expect.objectContaining({
          agentComposeVersionId:
            "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
        }),
      );
    });
  });

  describe("template variables", () => {
    it("should parse single template variable", async () => {
      let capturedBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--vars",
        "KEY1=value1",
      ]);

      expect(capturedBody).toEqual({
        agentComposeId: testUuid,
        prompt: "test prompt",
        vars: { KEY1: "value1" },
        secrets: undefined,
        volumeVersions: undefined,
        conversationId: undefined,
      });
    });

    it("should parse multiple template variables", async () => {
      let capturedBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--vars",
        "KEY1=value1",
        "--vars",
        "KEY2=value2",
      ]);

      expect(capturedBody).toEqual({
        agentComposeId: testUuid,
        prompt: "test prompt",
        vars: { KEY1: "value1", KEY2: "value2" },
        secrets: undefined,
        volumeVersions: undefined,
        conversationId: undefined,
      });
    });

    it("should handle values containing equals signs", async () => {
      let capturedBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--vars",
        "URL=https://example.com?foo=bar",
      ]);

      expect(capturedBody).toEqual({
        agentComposeId: testUuid,
        prompt: "test prompt",
        vars: { URL: "https://example.com?foo=bar" },
        secrets: undefined,
        volumeVersions: undefined,
        conversationId: undefined,
      });
    });

    it("should reject empty template variable values", async () => {
      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--vars",
          "EMPTY=",
        ]);
      }).rejects.toThrow("Invalid format: EMPTY=");
    });

    it("should reject invalid template variable format (missing value)", async () => {
      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--vars",
          "INVALID",
        ]);
      }).rejects.toThrow();
    });

    it("should reject invalid template variable format (missing key)", async () => {
      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--vars",
          "=value",
        ]);
      }).rejects.toThrow();
    });

    it("should omit vars when no vars provided", async () => {
      let capturedBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      expect(capturedBody).toEqual({
        agentComposeId: testUuid,
        prompt: "test prompt",
        vars: undefined,
        secrets: undefined,
        volumeVersions: undefined,
        conversationId: undefined,
      });
    });
  });

  describe("--append-system-prompt flag", () => {
    it("should pass append-system-prompt to API", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--append-system-prompt",
        "Your name is Aria.",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          appendSystemPrompt: "Your name is Aria.",
        }),
      );
    });
  });

  describe("--disallowed-tools flag", () => {
    it("should pass disallowed-tools to API", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--disallowed-tools",
        "CronCreate",
        "WebSearch",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          disallowedTools: ["CronCreate", "WebSearch"],
        }),
      );
    });
  });

  describe("--tools flag", () => {
    it("should pass tools to API", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--tools",
        "Bash",
        "Edit",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          tools: ["Bash", "Edit"],
        }),
      );
    });
  });

  describe("--settings flag", () => {
    it("should pass settings to API", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--settings",
        '{"hooks":{}}',
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          settings: '{"hooks":{}}',
        }),
      );
    });
  });

  describe("error handling", () => {
    it("should handle authentication errors", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle compose not found errors", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            { error: { message: "Compose not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("404"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Compose not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle API errors with message", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            { error: { message: "Execution failed", code: "SERVER_ERROR" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("500"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Execution failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.error();
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
      }).rejects.toThrow("process.exit called");

      // Network error from HttpResponse.error() manifests as "Failed to fetch"
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("event polling", () => {
    it("should poll for events after creating run", async () => {
      let pollCount = 0;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/events",
          ({ request }) => {
            const url = new URL(request.url);
            const since = url.searchParams.get("since");
            pollCount++;

            if (since === "-1") {
              // First poll (since=-1 to get event 0)
              return HttpResponse.json({
                events: [
                  {
                    sequenceNumber: 0,
                    eventType: "init",
                    eventData: { type: "init", sessionId: "session-123" },
                    createdAt: "2025-01-01T00:00:00Z",
                  },
                ],
                hasMore: false,
                nextSequence: 0,
                run: { status: "running" },
                framework: "claude-code",
              });
            }
            // Second poll (since=0)
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "text",
                  eventData: { type: "text", text: "Processing..." },
                  createdAt: "2025-01-01T00:00:01Z",
                },
                {
                  sequenceNumber: 2,
                  eventType: "result",
                  eventData: {
                    type: "result",
                    subtype: "success",
                    is_error: false,
                    duration_ms: 1000,
                    num_turns: 1,
                    result: "Done",
                    session_id: "test",
                    total_cost_usd: 0,
                    usage: {},
                  },
                  createdAt: "2025-01-01T00:00:02Z",
                },
              ],
              hasMore: false,
              nextSequence: 2,
              run: {
                status: "completed",
                result: {
                  checkpointId: "cp-123",
                  agentSessionId: "session-123",
                  conversationId: "conv-123",
                  artifact: {},
                },
              },
              framework: "claude-code",
            });
          },
        ),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      expect(pollCount).toBeGreaterThanOrEqual(2);
    });

    it("should parse and render events as they arrive", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 0,
                eventType: "init",
                eventData: { type: "init", sessionId: "session-123" },
                createdAt: "2025-01-01T00:00:00Z",
              },
              {
                sequenceNumber: 1,
                eventType: "result",
                eventData: {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  duration_ms: 1000,
                  num_turns: 1,
                  result: "Done",
                  session_id: "test",
                  total_cost_usd: 0,
                  usage: {},
                },
                createdAt: "2025-01-01T00:00:01Z",
              },
            ],
            hasMore: false,
            nextSequence: 1,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      // Verify events are rendered to console (without ANSI colors due to chalk.level = 0)
      // The init event shows session ID in the completion summary
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Session:"),
      );
      // Result event is rendered with success message
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("completed successfully"),
      );
    });

    it("should stop polling when run status is completed", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          // With new architecture, polling stops when run.status is completed
          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 0,
                eventType: "result",
                eventData: {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  duration_ms: 1000,
                  num_turns: 1,
                  result: "Done",
                  session_id: "test",
                  total_cost_usd: 0,
                  usage: {},
                },
                createdAt: "2025-01-01T00:00:00Z",
              },
            ],
            hasMore: false,
            nextSequence: 0,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      // Should only call getEvents once since status is completed
      expect(pollCount).toBe(1);
    });

    it("should drain terminal events that become visible after completion", async () => {
      vi.useFakeTimers();
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount === 1) {
            return HttpResponse.json({
              events: [],
              hasMore: false,
              nextSequence: -1,
              run: {
                status: "completed",
                result: {
                  checkpointId: "cp-1",
                  agentSessionId: "s-1",
                  conversationId: "c-1",
                  artifact: {},
                },
              },
              framework: "claude-code",
            });
          }

          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 0,
                eventType: "result",
                eventData: {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  duration_ms: 1000,
                  num_turns: 1,
                  result: "Done",
                  session_id: "test",
                  total_cost_usd: 0,
                  usage: {},
                },
                createdAt: "2025-01-01T00:00:01Z",
              },
            ],
            hasMore: false,
            nextSequence: 0,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      const commandPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
      ]);
      await vi.advanceTimersByTimeAsync(500);
      await commandPromise;

      expect(pollCount).toBe(2);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Run completed successfully"),
      );

      const logMessages = mockConsoleLog.mock.calls.map((call) => {
        return call[0];
      });
      const resultIndex = logMessages.findIndex((message) => {
        return String(message).includes("Agent Completed");
      });
      const completionIndex = logMessages.findIndex((message) => {
        return String(message).includes("Run completed successfully");
      });
      expect(resultIndex).toBeGreaterThan(-1);
      expect(completionIndex).toBeGreaterThan(resultIndex);
    });

    it("should not idle drain after result is visible before completion", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount === 1) {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 0,
                  eventType: "result",
                  eventData: {
                    type: "result",
                    subtype: "success",
                    is_error: false,
                    duration_ms: 1000,
                    num_turns: 1,
                    result: "Done",
                    session_id: "test",
                    total_cost_usd: 0,
                    usage: {},
                  },
                  createdAt: "2025-01-01T00:00:01Z",
                },
              ],
              hasMore: false,
              nextSequence: 0,
              run: { status: "running" },
              framework: "claude-code",
            });
          }

          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      expect(pollCount).toBe(2);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Agent Completed"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Run completed successfully"),
      );
    });

    it("should not drain additional pages after result is visible without watermark", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 0,
                eventType: "result",
                eventData: {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  duration_ms: 1000,
                  num_turns: 1,
                  result: "Done",
                  session_id: "test",
                  total_cost_usd: 0,
                  usage: {},
                },
                createdAt: "2025-01-01T00:00:01Z",
              },
            ],
            hasMore: true,
            nextSequence: 0,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      expect(pollCount).toBe(1);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Agent Completed"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Run completed successfully"),
      );
    });

    it("should keep draining to terminal watermark after result is visible", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount === 1) {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 0,
                  eventType: "result",
                  eventData: {
                    type: "result",
                    subtype: "success",
                    is_error: false,
                    duration_ms: 1000,
                    num_turns: 1,
                    result: "Done",
                    session_id: "test",
                    total_cost_usd: 0,
                    usage: {},
                  },
                  createdAt: "2025-01-01T00:00:00Z",
                },
              ],
              hasMore: true,
              nextSequence: 0,
              run: {
                status: "completed",
                lastEventSequence: 2,
                result: {
                  checkpointId: "cp-1",
                  agentSessionId: "s-1",
                  conversationId: "c-1",
                  artifact: {},
                },
              },
              framework: "claude-code",
            });
          }

          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 1,
                eventType: "assistant",
                eventData: {
                  type: "assistant",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "post-result page" }],
                  },
                },
                createdAt: "2025-01-01T00:00:01Z",
              },
              {
                sequenceNumber: 2,
                eventType: "assistant",
                eventData: {
                  type: "assistant",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "terminal watermark" }],
                  },
                },
                createdAt: "2025-01-01T00:00:02Z",
              },
            ],
            hasMore: false,
            nextSequence: 2,
            run: {
              status: "completed",
              lastEventSequence: 2,
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      expect(pollCount).toBe(2);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Agent Completed"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("terminal watermark"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Run completed successfully"),
      );
    });

    it("should not idle drain after codex result is visible before completion", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount === 1) {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 0,
                  eventType: "turn.completed",
                  eventData: {
                    type: "turn.completed",
                    usage: {
                      input_tokens: 10,
                      cached_input_tokens: 5,
                      output_tokens: 3,
                    },
                  },
                  createdAt: "2025-01-01T00:00:01Z",
                },
              ],
              hasMore: false,
              nextSequence: 0,
              run: { status: "running" },
              framework: "codex",
            });
          }

          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "codex",
          });
        }),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      expect(pollCount).toBe(2);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Agent Completed"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Run completed successfully"),
      );
    });

    it("should wait for terminal watermark instead of exiting on idle", async () => {
      vi.useFakeTimers();
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount < 4) {
            return HttpResponse.json({
              events: [],
              hasMore: false,
              nextSequence: -1,
              run: {
                status: "completed",
                lastEventSequence: 0,
                result: {
                  checkpointId: "cp-1",
                  agentSessionId: "s-1",
                  conversationId: "c-1",
                  artifact: {},
                },
              },
              framework: "claude-code",
            });
          }

          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 0,
                eventType: "result",
                eventData: {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  duration_ms: 1000,
                  num_turns: 1,
                  result: "Done",
                  session_id: "test",
                  total_cost_usd: 0,
                  usage: {},
                },
                createdAt: "2025-01-01T00:00:01Z",
              },
            ],
            hasMore: false,
            nextSequence: 0,
            run: {
              status: "completed",
              lastEventSequence: 0,
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      const commandPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
      ]);
      await vi.advanceTimersByTimeAsync(1500);
      await commandPromise;

      expect(pollCount).toBe(4);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Agent Completed"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Run completed successfully"),
      );
    });

    it("should return when terminal watermark was already reached before completion", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount === 1) {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 0,
                  eventType: "assistant",
                  eventData: {
                    type: "assistant",
                    message: {
                      role: "assistant",
                      content: [
                        { type: "text", text: "already visible before done" },
                      ],
                    },
                  },
                  createdAt: "2025-01-01T00:00:00Z",
                },
              ],
              hasMore: true,
              nextSequence: 0,
              run: { status: "running" },
              framework: "claude-code",
            });
          }

          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: {
              status: "completed",
              lastEventSequence: 0,
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      expect(pollCount).toBe(2);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("already visible before done"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Run completed successfully"),
      );
    });

    it("should drain visible terminal pages before rendering completion", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount === 1) {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 0,
                  eventType: "assistant",
                  eventData: {
                    type: "assistant",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "first page" }],
                    },
                  },
                  createdAt: "2025-01-01T00:00:00Z",
                },
              ],
              hasMore: true,
              nextSequence: 0,
              run: {
                status: "completed",
                result: {
                  checkpointId: "cp-1",
                  agentSessionId: "s-1",
                  conversationId: "c-1",
                  artifact: {},
                },
              },
              framework: "claude-code",
            });
          }

          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 1,
                eventType: "assistant",
                eventData: {
                  type: "assistant",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "second page" }],
                  },
                },
                createdAt: "2025-01-01T00:00:01Z",
              },
              {
                sequenceNumber: 2,
                eventType: "result",
                eventData: {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  duration_ms: 1000,
                  num_turns: 1,
                  result: "Done",
                  session_id: "test",
                  total_cost_usd: 0,
                  usage: {},
                },
                createdAt: "2025-01-01T00:00:02Z",
              },
            ],
            hasMore: false,
            nextSequence: 2,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      expect(pollCount).toBe(2);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("first page"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("second page"),
      );
    });

    it("should bound terminal drain when a sequence gap never fills", async () => {
      vi.useFakeTimers();
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount === 1) {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 0,
                  eventType: "assistant",
                  eventData: {
                    type: "assistant",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "before gap" }],
                    },
                  },
                  createdAt: "2025-01-01T00:00:00Z",
                },
              ],
              hasMore: true,
              nextSequence: 0,
              run: {
                status: "completed",
                result: {
                  checkpointId: "cp-1",
                  agentSessionId: "s-1",
                  conversationId: "c-1",
                  artifact: {},
                },
              },
              framework: "claude-code",
            });
          }

          return HttpResponse.json({
            events: [],
            hasMore: true,
            nextSequence: 0,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      const commandPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
      ]);
      await vi.advanceTimersByTimeAsync(4000);
      await commandPromise;

      expect(pollCount).toBeGreaterThan(2);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("before gap"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Run completed successfully"),
      );
    });

    it("should bound terminal drain when terminal watermark never becomes visible", async () => {
      vi.useFakeTimers();
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: -1,
            run: {
              status: "completed",
              lastEventSequence: 0,
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      const commandPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
      ]);
      await vi.advanceTimersByTimeAsync(4000);
      await commandPromise;

      expect(pollCount).toBeGreaterThan(2);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Run completed successfully"),
      );
    });

    it("should render the latest terminal status after drain", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount === 1) {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 0,
                  eventType: "assistant",
                  eventData: {
                    type: "assistant",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "before upgrade" }],
                    },
                  },
                  createdAt: "2025-01-01T00:00:00Z",
                },
              ],
              hasMore: true,
              nextSequence: 0,
              run: { status: "timeout" },
              framework: "claude-code",
            });
          }

          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 1,
                eventType: "result",
                eventData: {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  duration_ms: 1000,
                  num_turns: 1,
                  result: "Done",
                  session_id: "test",
                  total_cost_usd: 0,
                  usage: {},
                },
                createdAt: "2025-01-01T00:00:01Z",
              },
            ],
            hasMore: false,
            nextSequence: 1,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Run completed successfully"),
      );
      expect(mockConsoleError).not.toHaveBeenCalledWith(
        expect.stringContaining("Run timed out"),
      );
    });

    it("should skip events that fail to parse", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 0,
                eventType: "unknown",
                eventData: null,
                createdAt: "2025-01-01T00:00:00Z",
              },
              {
                sequenceNumber: 1,
                eventType: "result",
                eventData: {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  duration_ms: 1000,
                  num_turns: 1,
                  result: "Done",
                  session_id: "test",
                  total_cost_usd: 0,
                  usage: {},
                },
                createdAt: "2025-01-01T00:00:01Z",
              },
            ],
            hasMore: false,
            nextSequence: 1,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-1",
                agentSessionId: "s-1",
                conversationId: "c-1",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      // Should only render the result event (unknown events are skipped)
      // Verify the result event is in console output
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("completed successfully"),
      );
    });

    it("should handle polling errors gracefully", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount === 1) {
            // First poll succeeds
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 0,
                  eventType: "init",
                  eventData: { type: "init", sessionId: "session-123" },
                  createdAt: "2025-01-01T00:00:00Z",
                },
              ],
              hasMore: false,
              nextSequence: 0,
              run: { status: "running" },
              framework: "claude-code",
            });
          }
          // Second poll fails
          return HttpResponse.json(
            { error: { message: "Network error", code: "SERVER_ERROR" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
      }).rejects.toThrow("process.exit called");

      // Errors from polling bubble up and are formatted by withErrorHandler as ApiRequestError
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("500"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Network error"),
      );
    });

    it("should exit with error when run fails (status: failed)", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          // Return no events with "failed" status and error message
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: { status: "failed", error: "Agent crashed" },
            framework: "claude-code",
          });
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
      }).rejects.toThrow("process.exit called");

      // Verify error message is rendered to console
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run failed"),
      );
      expect(pollCount).toBe(1);
    });

    it("should not drain additional pages after failed status without watermark", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 0,
                eventType: "assistant",
                eventData: {
                  type: "assistant",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "failure context" }],
                  },
                },
                createdAt: "2025-01-01T00:00:00Z",
              },
            ],
            hasMore: true,
            nextSequence: 0,
            run: { status: "failed", error: "Agent crashed" },
            framework: "claude-code",
          });
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(pollCount).toBe(1);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("failure context"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run failed"),
      );
    });

    it("should wait for terminal watermark before rendering failed run", async () => {
      vi.useFakeTimers();
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount === 1) {
            return HttpResponse.json({
              events: [],
              hasMore: false,
              nextSequence: -1,
              run: {
                status: "failed",
                error: "Agent crashed",
                lastEventSequence: 0,
              },
              framework: "claude-code",
            });
          }

          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 0,
                eventType: "assistant",
                eventData: {
                  type: "assistant",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "failure context" }],
                  },
                },
                createdAt: "2025-01-01T00:00:00Z",
              },
            ],
            hasMore: false,
            nextSequence: 0,
            run: {
              status: "failed",
              error: "Agent crashed",
              lastEventSequence: 0,
            },
            framework: "claude-code",
          });
        }),
      );

      const commandPromise = expect(
        runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]),
      ).rejects.toThrow("process.exit called");
      await vi.advanceTimersByTimeAsync(500);
      await commandPromise;

      expect(pollCount).toBe(2);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("failure context"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run failed"),
      );
    });

    it("should exit immediately when run is cancelled without terminal watermark", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: -1,
            run: { status: "cancelled" },
            framework: "claude-code",
          });
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run cancelled"),
      );
      expect(pollCount).toBe(1);
    });

    it("should exit with error when run times out (status: timeout)", async () => {
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          // Return no events with "timeout" status - sandbox heartbeat expired
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: { status: "timeout" },
            framework: "claude-code",
          });
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run timed out"),
      );
      expect(pollCount).toBe(1);
    });

    it("should bound terminal drain when completed has no result event or watermark", async () => {
      vi.useFakeTimers();
      let pollCount = 0;
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-123",
                agentSessionId: "session-123",
                conversationId: "conv-123",
                artifact: {},
              },
            },
            framework: "claude-code",
          });
        }),
      );

      const commandPromise = runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
      ]);
      await vi.advanceTimersByTimeAsync(1000);
      await commandPromise;

      expect(pollCount).toBeGreaterThan(1);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Session:"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Checkpoint:"),
      );
    });
  });

  describe("org error handling", () => {
    it("should show error when org does not exist", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          const org = url.searchParams.get("org");

          if (org === "nonexistent-org-xyz123") {
            return HttpResponse.json(
              {
                error: {
                  message: "Org not found: nonexistent-org-xyz123",
                  code: "NOT_FOUND",
                },
              },
              { status: 404 },
            );
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "nonexistent-org-xyz123/my-agent",
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should provide helpful error message for non-existent org", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Org not found: invalid-org",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "invalid-org/test-agent",
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Agent not found"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 compose"),
      );
    });

    it("should show error when agent does not exist in valid org", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          const name = url.searchParams.get("name");
          const org = url.searchParams.get("org");

          if (org === "user-abc12345" && name === "nonexistent-agent-xyz123") {
            return HttpResponse.json(
              {
                error: {
                  message:
                    "Compose not found: nonexistent-agent-xyz123 in org user-abc12345",
                  code: "NOT_FOUND",
                },
              },
              { status: 404 },
            );
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "user-abc12345/nonexistent-agent-xyz123",
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Agent not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should suggest creating a compose when agent not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Compose not found: missing-agent",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "user-org/missing-agent",
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 compose"),
      );
    });

    it("should not allow access to agent from different org", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          const name = url.searchParams.get("name");
          const org = url.searchParams.get("org");

          if (org === "other-user-org" && name === "my-agent") {
            return HttpResponse.json(
              {
                error: {
                  message: "Compose not found: my-agent in org other-user-org",
                  code: "NOT_FOUND",
                },
              },
              { status: 404 },
            );
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "other-user-org/my-agent",
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should treat org isolation as not found rather than forbidden", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Compose not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "another-org/secret-agent",
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      const allErrors = mockConsoleError.mock.calls.map((call) => {
        return call[0] as string;
      });
      const hasForbidden = allErrors.some((err) => {
        return (
          err.toLowerCase().includes("forbidden") ||
          err.toLowerCase().includes("unauthorized") ||
          err.toLowerCase().includes("permission denied")
        );
      });
      expect(hasForbidden).toBe(false);

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
    });
  });

  describe("--env-file option", () => {
    it("should error when --env-file points to nonexistent file", async () => {
      // Use a compose that references variables to trigger loadValues
      const composeWithVars = {
        id: testUuid,
        name: "test-agent",
        headVersionId: "version-123",
        content: {
          version: "1",
          agents: {
            "test-agent": {
              provider: "claude",
              environment: {
                API_KEY: "${{ vars.API_KEY }}",
              },
            },
          },
        },
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };

      server.use(
        http.get("http://localhost:3000/api/agent/composes/:id", () => {
          return HttpResponse.json(composeWithVars);
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--env-file",
          "/nonexistent/path/.env",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Environment file not found: /nonexistent/path/.env",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("--vars and --secrets priority with --env-file", () => {
    let tempDir: string;

    // Compose that references vars and secrets
    const composeWithVarsAndSecrets = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "test-agent",
      headVersionId: "version-123",
      content: {
        version: "1",
        agents: {
          "test-agent": {
            provider: "claude",
            environment: {
              API_URL: "${{ vars.API_URL }}",
              API_KEY: "${{ secrets.API_KEY }}",
            },
          },
        },
      },
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };

    beforeEach(() => {
      tempDir = mkdtempSync(path.join(os.tmpdir(), "test-run-env-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("should prioritize CLI --vars over --env-file", async () => {
      // Create env file with API_URL
      const envFilePath = path.join(tempDir, ".env");
      writeFileSync(envFilePath, "API_URL=from-file\nAPI_KEY=secret-from-file");

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/composes/:id", () => {
          return HttpResponse.json(composeWithVarsAndSecrets);
        }),
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--vars",
        "API_URL=from-cli",
        "--env-file",
        envFilePath,
      ]);

      // CLI --vars should take priority over --env-file
      expect(capturedBody?.vars).toEqual({ API_URL: "from-cli" });
      // secrets from env file should still be loaded
      expect(capturedBody?.secrets).toEqual({ API_KEY: "secret-from-file" });
    });

    it("should load vars from --env-file when not provided via CLI", async () => {
      const envFilePath = path.join(tempDir, ".env");
      writeFileSync(envFilePath, "API_URL=from-file\nAPI_KEY=secret-from-file");

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/composes/:id", () => {
          return HttpResponse.json(composeWithVarsAndSecrets);
        }),
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--env-file",
        envFilePath,
      ]);

      // Both vars and secrets should be loaded from env file
      expect(capturedBody?.vars).toEqual({ API_URL: "from-file" });
      expect(capturedBody?.secrets).toEqual({ API_KEY: "secret-from-file" });
    });

    it("should load vars from environment when no --env-file provided", async () => {
      // Stub environment variables
      vi.stubEnv("API_URL", "from-env");
      vi.stubEnv("API_KEY", "secret-from-env");

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/composes/:id", () => {
          return HttpResponse.json(composeWithVarsAndSecrets);
        }),
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      // Both vars and secrets should be loaded from environment
      expect(capturedBody?.vars).toEqual({ API_URL: "from-env" });
      expect(capturedBody?.secrets).toEqual({ API_KEY: "secret-from-env" });
    });

    it("should prioritize --env-file over environment variables", async () => {
      // Stub environment variables
      vi.stubEnv("API_URL", "from-env");
      vi.stubEnv("API_KEY", "secret-from-env");

      // Create env file with different values
      const envFilePath = path.join(tempDir, ".env");
      writeFileSync(envFilePath, "API_URL=from-file\nAPI_KEY=secret-from-file");

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/composes/:id", () => {
          return HttpResponse.json(composeWithVarsAndSecrets);
        }),
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--env-file",
        envFilePath,
      ]);

      // --env-file should override environment variables
      expect(capturedBody?.vars).toEqual({ API_URL: "from-file" });
      expect(capturedBody?.secrets).toEqual({ API_KEY: "secret-from-file" });
    });

    it("should use env fallback for keys not in --env-file", async () => {
      // Stub environment variable for API_KEY only
      vi.stubEnv("API_KEY", "secret-from-env");

      // Create env file with API_URL only (missing API_KEY)
      const envFilePath = path.join(tempDir, ".env");
      writeFileSync(envFilePath, "API_URL=from-file");

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/composes/:id", () => {
          return HttpResponse.json(composeWithVarsAndSecrets);
        }),
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--env-file",
        envFilePath,
      ]);

      // API_URL from file, API_KEY from environment
      expect(capturedBody?.vars).toEqual({ API_URL: "from-file" });
      expect(capturedBody?.secrets).toEqual({ API_KEY: "secret-from-env" });
    });

    it("should handle mixed priority: CLI > file > env", async () => {
      // Stub environment variables
      vi.stubEnv("API_URL", "from-env");
      vi.stubEnv("API_KEY", "secret-from-env");

      // Create env file
      const envFilePath = path.join(tempDir, ".env");
      writeFileSync(envFilePath, "API_URL=from-file\nAPI_KEY=secret-from-file");

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/composes/:id", () => {
          return HttpResponse.json(composeWithVarsAndSecrets);
        }),
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      // CLI provides only API_URL, file has both, env has both
      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--vars",
        "API_URL=from-cli",
        "--env-file",
        envFilePath,
      ]);

      // API_URL from CLI (highest priority), API_KEY from file (medium priority)
      expect(capturedBody?.vars).toEqual({ API_URL: "from-cli" });
      expect(capturedBody?.secrets).toEqual({ API_KEY: "secret-from-file" });
    });
  });

  describe("error message formatting", () => {
    const errorTestRunId = "run-error-test-123";
    const errorTestRunResponse = {
      runId: errorTestRunId,
      status: "running",
      sandboxId: "sbx-456",
      executionTimeMs: 1000,
      createdAt: "2025-01-01T00:00:00Z",
    };

    function createFailedEventsResponse(errorMessage: string) {
      return {
        events: [],
        hasMore: false,
        nextSequence: 0,
        run: {
          status: "failed",
          error: errorMessage,
        },
        framework: "claude-code",
      };
    }

    it("should display detailed error message instead of generic exit code", async () => {
      const detailedError =
        "Error: Could not resume session 'test-session': Session history file not found";

      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(errorTestRunResponse, { status: 201 });
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json(createFailedEventsResponse(detailedError));
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
      }).rejects.toThrow("process.exit called");

      const allErrors = mockConsoleError.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });

      expect(
        allErrors.some((log) => {
          return log.includes("Run failed");
        }),
      ).toBe(true);
      expect(
        allErrors.some((log) => {
          return log.includes("Could not resume session");
        }),
      ).toBe(true);
      expect(
        allErrors.some((log) => {
          return log.includes("Session history file not found");
        }),
      ).toBe(true);
      expect(
        allErrors.some((log) => {
          return log.includes("Agent exited with code 1");
        }),
      ).toBe(false);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show system logs hint for debugging", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(errorTestRunResponse, { status: 201 });
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json(
            createFailedEventsResponse("Some error occurred"),
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
      }).rejects.toThrow("process.exit called");

      const allErrors = mockConsoleError.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });

      expect(
        allErrors.some((log) => {
          return log.includes(`vm0 logs ${errorTestRunId} --system`);
        }),
      ).toBe(true);
    });

    it("should handle undefined error gracefully", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(errorTestRunResponse, { status: 201 });
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: { status: "failed" },
            framework: "claude-code",
          });
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
      }).rejects.toThrow("process.exit called");

      const allErrors = mockConsoleError.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });

      expect(
        allErrors.some((log) => {
          return log.includes("Unknown error");
        }),
      ).toBe(true);
    });

    it.each([
      {
        error: "Error: Authentication failed: Invalid API key",
        expected: "Authentication failed",
      },
      {
        error: "Error: Network request failed: ECONNREFUSED",
        expected: "Network request failed",
      },
      {
        error: "Error: Permission denied: Cannot write to /etc/passwd",
        expected: "Permission denied",
      },
      {
        error: "Error: Operation timed out after 300000ms",
        expected: "timed out",
      },
    ])(
      "should display error pattern: $expected",
      async ({ error, expected }) => {
        server.use(
          http.post("http://localhost:3000/api/agent/runs", () => {
            return HttpResponse.json(errorTestRunResponse, { status: 201 });
          }),
          http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
            return HttpResponse.json(createFailedEventsResponse(error));
          }),
        );

        await expect(async () => {
          await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);
        }).rejects.toThrow("process.exit called");

        const allErrors = mockConsoleError.mock.calls
          .map((call) => {
            return call[0];
          })
          .filter((log): log is string => {
            return typeof log === "string";
          });

        expect(
          allErrors.some((log) => {
            return log.includes(expected);
          }),
        ).toBe(true);
      },
    );
  });

  describe("--artifact flag", () => {
    it("sends artifacts[] for a single --artifact name:/path", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact",
        "my-data:/workspace",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          artifacts: [{ name: "my-data", mountPath: "/workspace" }],
        }),
      );
      expect(capturedBody?.artifactName).toBeUndefined();
      expect(capturedBody?.artifactVersion).toBeUndefined();
    });

    it("sends artifacts[] with version for --artifact name:version:/path", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact",
        "my-data:abc123:/data",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          artifacts: [
            { name: "my-data", version: "abc123", mountPath: "/data" },
          ],
        }),
      );
    });

    it("accepts multiple --artifact flags and preserves order", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact",
        "foo:/workspace",
        "--artifact",
        "bar:v3:/data",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          artifacts: [
            { name: "foo", mountPath: "/workspace" },
            { name: "bar", version: "v3", mountPath: "/data" },
          ],
        }),
      );
    });

    it("omits artifacts when flag is not provided", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await runCommand.parseAsync(["node", "cli", testUuid, "test prompt"]);

      expect(capturedBody?.artifacts).toBeUndefined();
      expect(capturedBody?.artifactName).toBeUndefined();
      expect(capturedBody?.artifactVersion).toBeUndefined();
    });

    it("rejects --artifact without a mount path", async () => {
      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--artifact",
          "only-name",
        ]);
      }).rejects.toThrow(/Invalid artifact format/);
    });

    it("rejects --artifact with an empty name", async () => {
      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--artifact",
          ":/workspace",
        ]);
      }).rejects.toThrow(/Invalid artifact format/);
    });

    it("rejects --artifact when mount path does not start with /", async () => {
      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--artifact",
          "name:workspace",
        ]);
      }).rejects.toThrow(/Invalid artifact mount path/);
    });
  });
});
