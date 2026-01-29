import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

describe("run list command", () => {
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
    vi.unstubAllEnvs();
  });

  describe("successful listing", () => {
    it("should display active runs in table format", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json({
            runs: [
              {
                id: "550e8400-e29b-41d4-a716-446655440000",
                agentName: "my-agent",
                status: "running",
                prompt: "test prompt",
                createdAt: new Date().toISOString(),
                startedAt: new Date().toISOString(),
              },
              {
                id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
                agentName: "data-analyzer",
                status: "pending",
                prompt: "analyze data",
                createdAt: new Date().toISOString(),
                startedAt: null,
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      // Check header is printed
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("ID"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("AGENT"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("STATUS"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("CREATED"),
      );

      // Check runs are printed
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("550e8400-e29b-41d4-a716-446655440000"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-agent"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("running"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("data-analyzer"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("pending"),
      );
    });

    it("should display only pending/running runs (server-side filtering)", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs", () => {
          // Internal API returns only pending/running runs by default
          return HttpResponse.json({
            runs: [
              {
                id: "run-1",
                agentName: "my-agent",
                status: "running",
                prompt: "test",
                createdAt: new Date().toISOString(),
                startedAt: new Date().toISOString(),
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      // Should show running run
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-agent"),
      );
    });

    it("should show 'No active runs' when list is empty", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json({
            runs: [],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("No active runs"),
      );
    });
  });

  describe("error handling", () => {
    it("should show auth error when not authenticated", async () => {
      vi.stubEnv("VM0_TOKEN", "");

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to list runs"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
    });

    it("should handle API errors gracefully", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            { error: { message: "Internal server error", code: "INTERNAL" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to list runs"),
      );
    });
  });
});
