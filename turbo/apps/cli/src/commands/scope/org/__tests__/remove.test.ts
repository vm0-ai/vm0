import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { removeCommand } from "../remove";

describe("scope org remove command", () => {
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
        await removeCommand.parseAsync(["node", "cli", "user-123"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("remove member", () => {
    it("should remove member successfully", async () => {
      server.use(
        http.delete("http://localhost:3000/api/org/members/user-123", () => {
          return HttpResponse.json({ success: true });
        }),
      );

      await removeCommand.parseAsync(["node", "cli", "user-123"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Member removed: user-123"),
      );
    });
  });

  describe("error handling", () => {
    it("should handle member not found", async () => {
      server.use(
        http.delete("http://localhost:3000/api/org/members/user-123", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Member not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await removeCommand.parseAsync(["node", "cli", "user-123"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Member not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle not being owner", async () => {
      server.use(
        http.delete("http://localhost:3000/api/org/members/user-123", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Only owners can remove members",
                code: "FORBIDDEN",
              },
            },
            { status: 403 },
          );
        }),
      );

      await expect(async () => {
        await removeCommand.parseAsync(["node", "cli", "user-123"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Only owners can remove members"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle cannot remove owner", async () => {
      server.use(
        http.delete("http://localhost:3000/api/org/members/owner-id", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Cannot remove the organization owner",
                code: "FORBIDDEN",
              },
            },
            { status: 403 },
          );
        }),
      );

      await expect(async () => {
        await removeCommand.parseAsync(["node", "cli", "owner-id"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Cannot remove the organization owner"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      server.use(
        http.delete("http://localhost:3000/api/org/members/user-123", () => {
          return HttpResponse.json(
            { error: { message: "Server error", code: "INTERNAL_ERROR" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await removeCommand.parseAsync(["node", "cli", "user-123"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
