import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { leaveCommand } from "../leave";

describe("scope org leave command", () => {
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
    vi.stubEnv("VM0_SCOPE", "test-org");
    vi.stubEnv("HOME", "/tmp/test-leave-config");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("authentication", () => {
    it("should exit with error if not authenticated", async () => {
      vi.stubEnv("VM0_TOKEN", "");

      await expect(async () => {
        await leaveCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("leave organization", () => {
    it("should leave organization successfully", async () => {
      server.use(
        http.post("http://localhost:3000/api/org/leave", () => {
          return HttpResponse.json({ success: true });
        }),
      );

      await leaveCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Left organization"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Switched to personal scope"),
      );
    });

    it("should error if not using org scope", async () => {
      vi.stubEnv("VM0_SCOPE", "");

      await expect(async () => {
        await leaveCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not currently using an organization scope"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle not a member", async () => {
      server.use(
        http.post("http://localhost:3000/api/org/leave", () => {
          return HttpResponse.json(
            {
              error: {
                message: "You are not a member of this organization",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await leaveCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not a member"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle owner cannot leave", async () => {
      server.use(
        http.post("http://localhost:3000/api/org/leave", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Owner cannot leave the organization",
                code: "FORBIDDEN",
              },
            },
            { status: 403 },
          );
        }),
      );

      await expect(async () => {
        await leaveCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Owner cannot leave"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      server.use(
        http.post("http://localhost:3000/api/org/leave", () => {
          return HttpResponse.json(
            { error: { message: "Server error", code: "INTERNAL_ERROR" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await leaveCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
