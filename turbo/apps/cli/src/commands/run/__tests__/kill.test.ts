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

  const testRunId = "550e8400-e29b-41d4-a716-446655440000";

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
    vi.unstubAllEnvs();
  });

  describe("successful cancellation", () => {
    it("should cancel a running run", async () => {
      server.use(
        http.post(
          `http://localhost:3000/api/agent/runs/${testRunId}/cancel`,
          () => {
            return HttpResponse.json({
              id: testRunId,
              status: "cancelled",
              message: "Run cancelled successfully",
            });
          },
        ),
      );

      await killCommand.parseAsync(["node", "cli", testRunId]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining(`Run ${testRunId} cancelled`),
      );
    });

    it("should cancel a pending run", async () => {
      const pendingRunId = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
      server.use(
        http.post(
          `http://localhost:3000/api/agent/runs/${pendingRunId}/cancel`,
          () => {
            return HttpResponse.json({
              id: pendingRunId,
              status: "cancelled",
              message: "Run cancelled successfully",
            });
          },
        ),
      );

      await killCommand.parseAsync(["node", "cli", pendingRunId]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining(`Run ${pendingRunId} cancelled`),
      );
    });
  });

  describe("error handling", () => {
    it("should show error when run not found", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000";
      server.use(
        http.post(
          `http://localhost:3000/api/agent/runs/${nonExistentId}/cancel`,
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: `No such run: '${nonExistentId}'`,
                  code: "NOT_FOUND",
                },
              },
              { status: 404 },
            );
          },
        ),
      );

      await expect(async () => {
        await killCommand.parseAsync(["node", "cli", nonExistentId]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill run"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run not found"),
      );
    });

    it("should show error when run is already completed", async () => {
      server.use(
        http.post(
          `http://localhost:3000/api/agent/runs/${testRunId}/cancel`,
          () => {
            return HttpResponse.json(
              {
                error: {
                  message:
                    "Run cannot be cancelled: current status is 'completed'",
                  code: "BAD_REQUEST",
                },
              },
              { status: 400 },
            );
          },
        ),
      );

      await expect(async () => {
        await killCommand.parseAsync(["node", "cli", testRunId]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill run"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("cannot be cancelled"),
      );
    });

    it("should show error when run is already cancelled", async () => {
      server.use(
        http.post(
          `http://localhost:3000/api/agent/runs/${testRunId}/cancel`,
          () => {
            return HttpResponse.json(
              {
                error: {
                  message:
                    "Run cannot be cancelled: current status is 'cancelled'",
                  code: "BAD_REQUEST",
                },
              },
              { status: 400 },
            );
          },
        ),
      );

      await expect(async () => {
        await killCommand.parseAsync(["node", "cli", testRunId]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill run"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("cannot be cancelled"),
      );
    });

    it("should show auth error when not authenticated", async () => {
      vi.stubEnv("VM0_TOKEN", "");

      await expect(async () => {
        await killCommand.parseAsync(["node", "cli", testRunId]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill run"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
    });

    it("should handle API errors gracefully", async () => {
      server.use(
        http.post(
          `http://localhost:3000/api/agent/runs/${testRunId}/cancel`,
          () => {
            return HttpResponse.json(
              { error: { message: "Internal server error", code: "INTERNAL" } },
              { status: 500 },
            );
          },
        ),
      );

      await expect(async () => {
        await killCommand.parseAsync(["node", "cli", testRunId]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill run"),
      );
    });
  });
});
