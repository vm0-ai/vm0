/**
 * Tests for zero run command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { mainRunCommand } from "../run";
import chalk from "chalk";

describe("zero run command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  const testAgentId = "550e8400-e29b-41d4-a716-446655440000";

  const defaultCreateRunResponse = {
    runId: "run-123",
    status: "running",
    sandboxId: "sbx-456",
    createdAt: "2025-01-01T00:00:00Z",
  };

  const defaultGetRunResponse = {
    runId: "run-123",
    agentComposeVersionId: null,
    status: "completed",
    prompt: "test prompt",
    appendSystemPrompt: null,
    result: {
      agentSessionId: "session-abc",
      checkpointId: "cp-123",
    },
    createdAt: "2025-01-01T00:00:00Z",
  };

  const defaultEventsResponse = {
    events: [],
    hasMore: false,
    framework: "claude-code",
  };

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    server.use(
      http.post("http://localhost:3000/api/zero/runs", () => {
        return HttpResponse.json(defaultCreateRunResponse, { status: 201 });
      }),
      http.get("http://localhost:3000/api/zero/runs/:id", () => {
        return HttpResponse.json(defaultGetRunResponse);
      }),
      http.get(
        "http://localhost:3000/api/zero/runs/:id/telemetry/agent",
        () => {
          return HttpResponse.json(defaultEventsResponse);
        },
      ),
    );
  });

  describe("agent ID validation", () => {
    it("should reject invalid agent ID format", async () => {
      await expect(async () => {
        await mainRunCommand.parseAsync([
          "node",
          "cli",
          "invalid-agent-id",
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent ID format"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("must be a valid UUID"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("successful run", () => {
    it("should create a zero run and poll to completion", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/zero/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultCreateRunResponse, { status: 201 });
          },
        ),
      );

      await mainRunCommand.parseAsync([
        "node",
        "cli",
        testAgentId,
        "Build a hello world app",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          agentId: testAgentId,
          prompt: "Build a hello world app",
        }),
      );
    });

    it("should drain visible event pages before rendering completion", async () => {
      let eventPolls = 0;

      server.use(
        http.get(
          "http://localhost:3000/api/zero/runs/:id/telemetry/agent",
          () => {
            eventPolls++;
            if (eventPolls === 1) {
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
                framework: "claude-code",
              });
            }

            if (eventPolls === 2) {
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
                    createdAt: "2025-01-01T00:00:00Z",
                  },
                ],
                hasMore: false,
                framework: "claude-code",
              });
            }

            return HttpResponse.json({
              events: [],
              hasMore: false,
              framework: "claude-code",
            });
          },
        ),
      );

      await mainRunCommand.parseAsync([
        "node",
        "cli",
        testAgentId,
        "test prompt",
      ]);

      expect(eventPolls).toBeGreaterThanOrEqual(2);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("second page"),
      );
    });

    it("should drain terminal events that appear after completion", async () => {
      let eventPolls = 0;

      server.use(
        http.get(
          "http://localhost:3000/api/zero/runs/:id/telemetry/agent",
          () => {
            eventPolls++;
            if (eventPolls === 1) {
              return HttpResponse.json({
                events: [
                  {
                    sequenceNumber: 0,
                    eventType: "assistant",
                    eventData: {
                      type: "assistant",
                      message: {
                        role: "assistant",
                        content: [{ type: "text", text: "before completion" }],
                      },
                    },
                    createdAt: "2025-01-01T00:00:00Z",
                  },
                ],
                hasMore: false,
                framework: "claude-code",
              });
            }

            if (eventPolls === 2) {
              return HttpResponse.json({
                events: [
                  {
                    sequenceNumber: 1,
                    eventType: "assistant",
                    eventData: {
                      type: "assistant",
                      message: {
                        role: "assistant",
                        content: [{ type: "text", text: "after completion" }],
                      },
                    },
                    createdAt: "2025-01-01T00:00:00Z",
                  },
                ],
                hasMore: false,
                framework: "claude-code",
              });
            }

            return HttpResponse.json({
              events: [],
              hasMore: false,
              framework: "claude-code",
            });
          },
        ),
      );

      await mainRunCommand.parseAsync([
        "node",
        "cli",
        testAgentId,
        "test prompt",
      ]);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("before completion"),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("after completion"),
      );
    });

    it("should render the latest terminal status after drain", async () => {
      let runPolls = 0;

      server.use(
        http.get("http://localhost:3000/api/zero/runs/:id", () => {
          runPolls++;
          if (runPolls === 1) {
            return HttpResponse.json({
              ...defaultGetRunResponse,
              status: "timeout",
              result: undefined,
            });
          }

          return HttpResponse.json(defaultGetRunResponse);
        }),
      );

      await mainRunCommand.parseAsync([
        "node",
        "cli",
        testAgentId,
        "test prompt",
      ]);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Run completed successfully"),
      );
      expect(mockConsoleError).not.toHaveBeenCalledWith(
        expect.stringContaining("Run timed out"),
      );
    });

    it("should not render events past a sequence gap", async () => {
      let eventPolls = 0;
      server.use(
        http.get(
          "http://localhost:3000/api/zero/runs/:id/telemetry/agent",
          () => {
            eventPolls++;
            if (eventPolls > 1) {
              return HttpResponse.json({
                events: [],
                hasMore: false,
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
                      content: [{ type: "text", text: "before gap" }],
                    },
                  },
                  createdAt: "2025-01-01T00:00:00Z",
                },
                {
                  sequenceNumber: 2,
                  eventType: "assistant",
                  eventData: {
                    type: "assistant",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "after gap" }],
                    },
                  },
                  createdAt: "2025-01-01T00:00:00Z",
                },
              ],
              hasMore: false,
              framework: "claude-code",
            });
          },
        ),
      );

      await mainRunCommand.parseAsync([
        "node",
        "cli",
        testAgentId,
        "test prompt",
      ]);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("before gap"),
      );
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining("after gap"),
      );
    });

    it("should pass model-provider option to API", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/zero/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultCreateRunResponse, { status: 201 });
          },
        ),
      );

      await mainRunCommand.parseAsync([
        "node",
        "cli",
        testAgentId,
        "test prompt",
        "--model-provider",
        "anthropic-api-key",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          modelProvider: "anthropic-api-key",
        }),
      );
    });
  });

  describe("error handling", () => {
    it("should handle run preparation failure", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-failed",
              status: "failed",
              error: "Agent not found",
              createdAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await expect(async () => {
        await mainRunCommand.parseAsync([
          "node",
          "cli",
          testAgentId,
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run preparation failed"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Agent not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle run failure during polling", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/runs/:id", () => {
          return HttpResponse.json({
            ...defaultGetRunResponse,
            status: "failed",
            error: "Agent crashed",
            result: undefined,
          });
        }),
      );

      await expect(async () => {
        await mainRunCommand.parseAsync([
          "node",
          "cli",
          testAgentId,
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle run timeout during polling", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/runs/:id", () => {
          return HttpResponse.json({
            ...defaultGetRunResponse,
            status: "timeout",
            result: undefined,
          });
        }),
      );

      await expect(async () => {
        await mainRunCommand.parseAsync([
          "node",
          "cli",
          testAgentId,
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run timed out"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
