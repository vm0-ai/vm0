/**
 * Tests for run kill command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { killCommand } from "../kill";
import chalk from "chalk";

describe("run kill command", () => {
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
    vi.unstubAllEnvs();
  });

  describe("successful kill", () => {
    it("should cancel a run successfully", async () => {
      const runId = "run-123-abc";
      let cancelledId: string | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs/:id/cancel",
          ({ params }) => {
            cancelledId = params.id as string;
            return HttpResponse.json({
              id: params.id,
              status: "cancelled",
              message: "Run cancelled successfully",
            });
          },
        ),
      );

      await killCommand.parseAsync(["node", "cli", runId]);

      expect(cancelledId).toBe(runId);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("cancelled");
      expect(logCalls).toContain(runId);
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs/:id/cancel", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Not authenticated",
                code: "UNAUTHORIZED",
              },
            },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await killCommand.parseAsync(["node", "cli", "run-123"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill run"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle run not found error", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs/:id/cancel", () => {
          return HttpResponse.json(
            {
              error: {
                message: "No such run: nonexistent-run",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await killCommand.parseAsync(["node", "cli", "nonexistent-run"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill run"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle run cannot be cancelled error", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs/:id/cancel", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Run cannot be cancelled: already completed",
                code: "BAD_REQUEST",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await killCommand.parseAsync(["node", "cli", "completed-run"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill run"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("cannot be cancelled"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle generic API error", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs/:id/cancel", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Internal server error",
                code: "SERVER_ERROR",
              },
            },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await killCommand.parseAsync(["node", "cli", "run-123"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill run"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Internal server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
