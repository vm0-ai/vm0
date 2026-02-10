import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { useCommand } from "../use";

describe("scope use command", () => {
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
    vi.stubEnv("HOME", "/tmp/test-use-config");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("authentication", () => {
    it("should exit with error if not authenticated when switching to org", async () => {
      vi.stubEnv("VM0_TOKEN", "");

      await expect(async () => {
        await useCommand.parseAsync(["node", "cli", "my-org"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("switch scope", () => {
    it("should switch to personal scope when no slug provided", async () => {
      await useCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Switched to personal scope"),
      );
    });

    it("should switch to organization scope", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope/list", () => {
          return HttpResponse.json({
            scopes: [
              {
                id: "scope-1",
                slug: "my-personal",
                type: "personal",
              },
              {
                id: "scope-2",
                slug: "my-org",
                type: "organization",
                role: "owner",
              },
            ],
          });
        }),
      );

      await useCommand.parseAsync(["node", "cli", "my-org"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Switched to scope: my-org"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("organization"),
      );
    });

    it("should switch to personal scope by slug", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope/list", () => {
          return HttpResponse.json({
            scopes: [
              {
                id: "scope-1",
                slug: "my-personal",
                type: "personal",
              },
            ],
          });
        }),
      );

      await useCommand.parseAsync(["node", "cli", "my-personal"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Switched to scope: my-personal"),
      );
    });
  });

  describe("error handling", () => {
    it("should error if scope not found or not accessible", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope/list", () => {
          return HttpResponse.json({
            scopes: [
              {
                id: "scope-1",
                slug: "my-personal",
                type: "personal",
              },
            ],
          });
        }),
      );

      await expect(async () => {
        await useCommand.parseAsync(["node", "cli", "nonexistent-org"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found or not accessible"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("my-personal"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope/list", () => {
          return HttpResponse.json(
            { error: { message: "Server error", code: "INTERNAL_ERROR" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await useCommand.parseAsync(["node", "cli", "my-org"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
