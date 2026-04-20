/**
 * Tests for memory list command
 *
 * Covers:
 * - Empty list display
 * - List with memory storages (table display)
 * - Error handling (auth, API errors)
 * - ls alias
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

describe("memory list", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("empty list", () => {
    it("should show no memory storages message", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json([]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("No memory storages found"),
      );
    });

    it("should show auto-creation hint", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json([]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("created automatically on first agent run"),
      );
    });
  });

  describe("list with memory storages", () => {
    it("should display table header", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json([
            {
              name: "memory",
              size: 1024,
              fileCount: 10,
              updatedAt: new Date().toISOString(),
            },
          ]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("NAME"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("SIZE"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("FILES"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("UPDATED"),
      );
    });

    it("should display memory storage info", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json([
            {
              name: "memory",
              size: 2048,
              fileCount: 5,
              updatedAt: new Date().toISOString(),
            },
          ]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("memory"),
      );
    });

    it("should display multiple memory storages", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json([
            {
              name: "memory",
              size: 1024,
              fileCount: 10,
              updatedAt: new Date().toISOString(),
            },
            {
              name: "my-memory",
              size: 2048,
              fileCount: 20,
              updatedAt: new Date().toISOString(),
            },
          ]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("memory"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-memory"),
      );
    });

    it("should pass type=memory query parameter", async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get("http://localhost:3000/api/storages/list", ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json([]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      expect(capturedUrl?.searchParams.get("type")).toBe("memory");
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle API error", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json(
            { error: { message: "Server error", code: "SERVER_ERROR" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("500: Server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("alias", () => {
    it("should have ls alias", () => {
      expect(listCommand.alias()).toBe("ls");
    });
  });
});
