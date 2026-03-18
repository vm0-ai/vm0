import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { statusCommand } from "../status";

describe("org status command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
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
      vi.stubEnv("VM0_TOKEN", "");
      vi.stubEnv("HOME", "/tmp/test-no-config");

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("no active organization", () => {
    it("should exit with error if no active org configured", async () => {
      vi.stubEnv("VM0_ACTIVE_ORG", "");
      vi.stubEnv("HOME", "/tmp/test-no-org-config");

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No active organization configured"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("no organization configured", () => {
    it("should show helpful message when user has no organization", async () => {
      server.use(
        http.get("http://localhost:3000/api/org", () => {
          return HttpResponse.json(
            { error: { message: "No org configured", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No organization configured"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 org set"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("organization display", () => {
    it("should display organization information", async () => {
      server.use(
        http.get("http://localhost:3000/api/org", () => {
          return HttpResponse.json({
            id: "test-id",
            slug: "testuser",
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          });
        }),
      );

      await statusCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Organization Information"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("testuser"),
      );
    });
  });

  describe("error handling", () => {
    it("should handle unexpected errors", async () => {
      server.use(
        http.get("http://localhost:3000/api/org", () => {
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
        http.get("http://localhost:3000/api/org", () => {
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
