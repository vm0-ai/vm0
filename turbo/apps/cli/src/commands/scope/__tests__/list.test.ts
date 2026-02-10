import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { listCommand } from "../list";

describe("scope list command", () => {
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
    vi.stubEnv("HOME", "/tmp/test-list-config");
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
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("list scopes", () => {
    it("should list personal scope only", async () => {
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

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Accessible Scopes"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-personal"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("personal"),
      );
    });

    it("should list personal and org scopes", async () => {
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
              {
                id: "scope-3",
                slug: "other-org",
                type: "organization",
                role: "member",
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-personal"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-org"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("other-org"),
      );
    });

    it("should indicate current scope with marker", async () => {
      vi.stubEnv("VM0_SCOPE", "my-org");

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

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Current scope: my-org"),
      );
    });
  });

  describe("error handling", () => {
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
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
