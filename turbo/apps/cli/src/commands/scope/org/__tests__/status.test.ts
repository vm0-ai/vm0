import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { statusCommand } from "../status";

describe("scope org status command", () => {
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

  describe("get organization status", () => {
    it("should display organization status with members", async () => {
      server.use(
        http.get("http://localhost:3000/api/org/status", () => {
          return HttpResponse.json({
            id: "org-id",
            slug: "test-org",
            type: "organization",
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
            memberCount: 2,
            members: [
              {
                id: "member-1",
                userId: "user-1",
                email: "owner@example.com",
                role: "owner",
                joinedAt: "2024-01-01T00:00:00Z",
              },
              {
                id: "member-2",
                userId: "user-2",
                role: "member",
                joinedAt: "2024-01-02T00:00:00Z",
              },
            ],
          });
        }),
      );

      await statusCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Organization Information"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("test-org"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Member Count: 2"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Members"),
      );
    });
  });

  describe("error handling", () => {
    it("should handle no organization owned", async () => {
      server.use(
        http.get("http://localhost:3000/api/org/status", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Organization not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("don't own an organization"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      server.use(
        http.get("http://localhost:3000/api/org/status", () => {
          return HttpResponse.json(
            { error: { message: "Server error", code: "INTERNAL_ERROR" } },
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
  });
});
