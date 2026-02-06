import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { statusCommand } from "../status";

describe("scope status command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("authentication", () => {
    it("should exit with error if not authenticated", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");
      // VM0_TOKEN not set - simulates unauthenticated state

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("no scope configured", () => {
    it("should show helpful message when user has no scope", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            { error: { message: "No scope configured", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("No scope configured"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 scope set"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("scope display", () => {
    it("should display scope information", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json({
            id: "test-id",
            slug: "testuser",
            type: "personal",
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          });
        }),
      );

      await statusCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Scope Information"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("testuser"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("personal"),
      );
    });
  });

  describe("error handling", () => {
    it("should handle unexpected errors", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            { error: { message: "Server error", code: "SERVER_ERROR" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle non-Error exceptions", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.error();
        }),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      // Network error from HttpResponse.error() manifests as "Failed to fetch"
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
