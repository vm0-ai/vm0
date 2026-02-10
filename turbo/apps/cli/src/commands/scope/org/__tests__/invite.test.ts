import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { inviteCommand } from "../invite";

describe("scope org invite command", () => {
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
        await inviteCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("create invite link", () => {
    it("should create invite link successfully", async () => {
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      server.use(
        http.post("http://localhost:3000/api/org/invite", () => {
          return HttpResponse.json(
            {
              token: "abc123token",
              url: "https://vm0.dev/invite/abc123token",
              expiresAt: expiresAt.toISOString(),
            },
            { status: 201 },
          );
        }),
      );

      await inviteCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Invite link created"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("https://vm0.dev/invite/abc123token"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("expires"),
      );
    });
  });

  describe("error handling", () => {
    it("should handle no organization owned", async () => {
      server.use(
        http.post("http://localhost:3000/api/org/invite", () => {
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
        await inviteCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("don't own an organization"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle not being owner", async () => {
      server.use(
        http.post("http://localhost:3000/api/org/invite", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Only owners can create invite links",
                code: "FORBIDDEN",
              },
            },
            { status: 403 },
          );
        }),
      );

      await expect(async () => {
        await inviteCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Only owners can create invite links"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      server.use(
        http.post("http://localhost:3000/api/org/invite", () => {
          return HttpResponse.json(
            { error: { message: "Server error", code: "INTERNAL_ERROR" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await inviteCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
