import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { createCommand } from "../create";

describe("scope org create command", () => {
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
        await createCommand.parseAsync(["node", "cli", "test-org"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("create organization", () => {
    it("should create organization successfully", async () => {
      server.use(
        http.post("http://localhost:3000/api/org", () => {
          return HttpResponse.json(
            {
              id: "org-id",
              slug: "test-org",
              type: "organization",
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await createCommand.parseAsync(["node", "cli", "test-org"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Organization created: test-org"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 scope use test-org"),
      );
    });
  });

  describe("error handling", () => {
    it("should handle user already owns an organization", async () => {
      server.use(
        http.post("http://localhost:3000/api/org", () => {
          return HttpResponse.json(
            {
              error: {
                message: "User already owns an organization",
                code: "CONFLICT",
              },
            },
            { status: 409 },
          );
        }),
      );

      await expect(async () => {
        await createCommand.parseAsync(["node", "cli", "test-org"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("already own an organization"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle slug already taken", async () => {
      server.use(
        http.post("http://localhost:3000/api/org", () => {
          return HttpResponse.json(
            {
              error: {
                message: 'Scope "test-org" already exists',
                code: "CONFLICT",
              },
            },
            { status: 409 },
          );
        }),
      );

      await expect(async () => {
        await createCommand.parseAsync(["node", "cli", "test-org"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("already taken"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      server.use(
        http.post("http://localhost:3000/api/org", () => {
          return HttpResponse.json(
            { error: { message: "Server error", code: "INTERNAL_ERROR" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await createCommand.parseAsync(["node", "cli", "test-org"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
