import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { runCommand } from "../run";
import * as config from "../../lib/api/config";
import { parseEvent } from "../../lib/events/event-parser-factory";
import { EventRenderer } from "../../lib/events/event-renderer";
import chalk from "chalk";

// Only mock config - use real api implementation with MSW
vi.mock("../../lib/api/config", () => ({
  getApiUrl: vi.fn(),
  getToken: vi.fn(),
}));

// Mock event rendering (not HTTP - pure logic modules)
vi.mock("../../lib/events/event-parser-factory");
vi.mock("../../lib/events/event-renderer");

describe("run command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  const testUuid = "550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(config.getApiUrl).mockResolvedValue("http://localhost:3000");
    vi.mocked(config.getToken).mockResolvedValue("test-token");

    // Default mock for parseEvent - returns null since completion
    // is now detected via run.status, not events
    vi.mocked(parseEvent).mockImplementation(() => null);

    // Default mock for EventRenderer
    vi.mocked(EventRenderer.render).mockImplementation(() => {});
    vi.mocked(EventRenderer.renderRunCompleted).mockImplementation(() => {});
    vi.mocked(EventRenderer.renderRunFailed).mockImplementation(() => {});

    // Default MSW handler for getComposeById (needed when using UUID)
    server.use(
      http.get(`http://localhost:3000/api/agent/composes/${testUuid}`, () => {
        return HttpResponse.json({
          id: testUuid,
          name: "test-agent",
          headVersionId: "version-123",
          content: {
            version: "1",
            agents: { "test-agent": { provider: "claude" } },
          },
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
        });
      }),
    );
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    server.resetHandlers();
  });

  describe("composeId validation", () => {
    it("should accept valid UUID format", async () => {
      const validUuid = testUuid;
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "Success",
              executionTimeMs: 1000,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
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
                createdAt: "2025-01-01T00:00:00Z",
              },
            ],
            hasMore: false,
            nextSequence: 1,
            run: { status: "completed" },
            provider: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        validUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      // Command should complete successfully
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should accept and resolve agent names", async () => {
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
            { error: { message: "Not found" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "Success",
              executionTimeMs: 1000,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
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
                createdAt: "2025-01-01T00:00:00Z",
              },
            ],
            hasMore: false,
            nextSequence: 1,
            run: { status: "completed" },
            provider: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should handle agent not found errors", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Compose not found: nonexistent-agent" } },
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
          "--artifact-name",
          "test-artifact",
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
            { error: { message: "Not found" } },
            { status: 404 },
          );
        }),
        http.get(
          "http://localhost:3000/api/agent/composes/versions",
          ({ request }) => {
            const url = new URL(request.url);
            if (url.searchParams.get("version") === "abc12345") {
              return HttpResponse.json({
                versionId:
                  "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
              });
            }
            return HttpResponse.json(
              { error: { message: "Version not found" } },
              { status: 404 },
            );
          },
        ),
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "Success",
              executionTimeMs: 1000,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
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
                createdAt: "2025-01-01T00:00:00Z",
              },
            ],
            hasMore: false,
            nextSequence: 1,
            run: { status: "completed" },
            provider: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "my-agent:abc12345",
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should use agentComposeId for :latest version", async () => {
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
            { error: { message: "Not found" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "Success",
              executionTimeMs: 1000,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
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
                createdAt: "2025-01-01T00:00:00Z",
              },
            ],
            hasMore: false,
            nextSequence: 1,
            run: { status: "completed" },
            provider: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "my-agent:latest",
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      // Should NOT call getComposeVersion for :latest
      expect(mockExit).not.toHaveBeenCalled();
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
            { error: { message: "Not found" } },
            { status: 404 },
          );
        }),
        http.get("http://localhost:3000/api/agent/composes/versions", () => {
          return HttpResponse.json(
            { error: { message: "Version 'deadbeef' not found" } },
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
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Version not found: deadbeef"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should parse scope/name format", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (
            url.searchParams.get("name") === "my-agent" &&
            url.searchParams.get("scope") === "user-abc123"
          ) {
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
            { error: { message: "Not found" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "Success",
              executionTimeMs: 1000,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
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
            provider: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "user-abc123/my-agent",
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should parse scope/name:version format", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (
            url.searchParams.get("name") === "my-agent" &&
            url.searchParams.get("scope") === "user-abc123"
          ) {
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
            { error: { message: "Not found" } },
            { status: 404 },
          );
        }),
        http.get("http://localhost:3000/api/agent/composes/versions", () => {
          return HttpResponse.json({
            versionId:
              "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
          });
        }),
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "Success",
              executionTimeMs: 1000,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
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
            provider: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        "user-abc123/my-agent:abc12345",
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe("template variables", () => {
    beforeEach(() => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "Success",
              executionTimeMs: 1000,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
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
                createdAt: "2025-01-01T00:00:00Z",
              },
            ],
            hasMore: false,
            nextSequence: 1,
            run: { status: "completed" },
            provider: "claude-code",
          });
        }),
      );
    });

    it("should parse single template variable", async () => {
      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--vars",
        "KEY1=value1",
      ]);

      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should parse multiple template variables", async () => {
      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--vars",
        "KEY1=value1",
        "--vars",
        "KEY2=value2",
      ]);

      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should handle values containing equals signs", async () => {
      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--vars",
        "URL=https://example.com?foo=bar",
      ]);

      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should reject empty template variable values", async () => {
      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--artifact-name",
          "test-artifact",
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
          "--artifact-name",
          "test-artifact",
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
          "--artifact-name",
          "test-artifact",
          "--vars",
          "=value",
        ]);
      }).rejects.toThrow();
    });

    it("should omit vars when no vars provided", async () => {
      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe("API interaction", () => {
    beforeEach(() => {
      server.use(
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
            provider: "claude-code",
          });
        }),
      );
    });

    it("should display starting messages in verbose mode", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "Success",
              executionTimeMs: 1000,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--verbose",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Creating agent run"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Prompt: test prompt"),
      );
    });

    it("should not display starting messages without verbose flag", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "Success",
              executionTimeMs: 1000,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      expect(mockConsoleLog).not.toHaveBeenCalledWith(
        expect.stringContaining("Creating agent run"),
      );
    });

    it("should display vars when provided in verbose mode", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "Success",
              executionTimeMs: 1000,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
        "--vars",
        "KEY=value",
        "--verbose",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Variables:"),
      );
    });
  });

  describe("error handling", () => {
    it("should handle authentication errors", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
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
            { error: { message: "Compose not found" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Agent not found"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 compose"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle API errors with message", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            { error: { message: "Execution failed" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle network errors", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.error();
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("event polling", () => {
    beforeEach(() => {
      // Mock EventRenderer to track render calls
      vi.mocked(EventRenderer.render).mockImplementation(() => {});
      vi.mocked(EventRenderer.renderRunCompleted).mockImplementation(() => {});
      vi.mocked(EventRenderer.renderRunFailed).mockImplementation(() => {});

      // Mock parseEvent to return parsed events
      vi.mocked(parseEvent).mockImplementation((raw) => {
        if (raw.type === "init") {
          return {
            type: "init",
            timestamp: new Date(),
            data: { sessionId: "session-123" },
          };
        }
        if (raw.type === "text") {
          return {
            type: "text",
            timestamp: new Date(),
            data: { text: raw.text as string },
          };
        }
        if (raw.type === "result") {
          return {
            type: "result",
            timestamp: new Date(),
            data: { success: true, result: "Done" },
          };
        }
        return null;
      });
    });

    it("should poll for events after creating run", async () => {
      let pollCount = 0;
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "",
              executionTimeMs: 0,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount === 1) {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "init",
                  eventData: { type: "init", sessionId: "session-123" },
                  createdAt: "2025-01-01T00:00:00Z",
                },
              ],
              hasMore: false,
              nextSequence: 1,
              run: { status: "running" },
              provider: "claude-code",
            });
          }
          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 2,
                eventType: "text",
                eventData: { type: "text", text: "Processing..." },
                createdAt: "2025-01-01T00:00:01Z",
              },
              {
                sequenceNumber: 3,
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
            nextSequence: 3,
            run: {
              status: "completed",
              result: {
                checkpointId: "cp-123",
                agentSessionId: "session-123",
                conversationId: "conv-123",
                artifact: {},
              },
            },
            provider: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      expect(pollCount).toBeGreaterThanOrEqual(2);
    });

    it("should parse and render events as they arrive", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "",
              executionTimeMs: 0,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 1,
                eventType: "init",
                eventData: { type: "init", sessionId: "session-123" },
                createdAt: "2025-01-01T00:00:00Z",
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
                createdAt: "2025-01-01T00:00:01Z",
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
            provider: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      expect(parseEvent).toHaveBeenCalledWith({
        type: "init",
        sessionId: "session-123",
      });
      expect(parseEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "result",
          subtype: "success",
        }),
      );
      expect(EventRenderer.render).toHaveBeenCalledTimes(2);
    });

    it("should stop polling when run status is completed", async () => {
      let pollCount = 0;
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "",
              executionTimeMs: 0,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
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
                createdAt: "2025-01-01T00:00:00Z",
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
            provider: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      // Should only call getEvents once since status is completed
      expect(pollCount).toBe(1);
    });

    it("should skip events that fail to parse", async () => {
      vi.mocked(parseEvent).mockImplementation((raw) => {
        if (raw.type === "unknown") {
          return null;
        }
        if (raw.type === "result") {
          return {
            type: "result",
            timestamp: new Date(),
            data: { success: true, result: "Done" },
          };
        }
        return null;
      });

      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "",
              executionTimeMs: 0,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 1,
                eventType: "unknown",
                eventData: { type: "unknown", data: "something" },
                createdAt: "2025-01-01T00:00:00Z",
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
                createdAt: "2025-01-01T00:00:01Z",
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
            provider: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      // Should only render the result event, not the unknown one
      expect(EventRenderer.render).toHaveBeenCalledTimes(1);
    });

    it("should handle polling errors gracefully", async () => {
      let pollCount = 0;
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "",
              executionTimeMs: 0,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          pollCount++;
          if (pollCount === 1) {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "init",
                  eventData: { type: "init", sessionId: "session-123" },
                  createdAt: "2025-01-01T00:00:00Z",
                },
              ],
              hasMore: false,
              nextSequence: 1,
              run: { status: "running" },
              provider: "claude-code",
            });
          }
          return HttpResponse.error();
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(chalk.red("✗ Run failed"));
    });

    it("should exit with error when run fails (status: failed)", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "",
              executionTimeMs: 0,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: { status: "failed", error: "Agent crashed" },
            provider: "claude-code",
          });
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(EventRenderer.renderRunFailed).toHaveBeenCalledWith(
        "Agent crashed",
        "run-123",
      );
    });

    it("should exit with error when run times out (status: timeout)", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "",
              executionTimeMs: 0,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: { status: "timeout" },
            provider: "claude-code",
          });
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          testUuid,
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        chalk.red("\n✗ Run timed out"),
      );
    });

    it("should handle completed status with result", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-123",
              status: "running",
              sandboxId: "sbx-456",
              output: "",
              executionTimeMs: 0,
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
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
            provider: "claude-code",
          });
        }),
      );

      await runCommand.parseAsync([
        "node",
        "cli",
        testUuid,
        "test prompt",
        "--artifact-name",
        "test-artifact",
      ]);

      expect(EventRenderer.renderRunCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          checkpointId: "cp-123",
          agentSessionId: "session-123",
        }),
        expect.anything(),
      );
    });
  });
});
