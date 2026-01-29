/**
 * Tests for volume list command
 *
 * Covers:
 * - Empty list display
 * - List with volumes (table display)
 * - Error handling (auth, API errors)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

describe("volume list", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("empty list", () => {
    it("should show no volumes message", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json([]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("No volumes found"),
      );
    });

    it("should show create hint", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json([]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 volume init"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 volume push"),
      );
    });
  });

  describe("list with volumes", () => {
    it("should display table header", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json([
            {
              name: "my-volume",
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

    it("should display volume info", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json([
            {
              name: "my-volume",
              size: 1024,
              fileCount: 10,
              updatedAt: new Date().toISOString(),
            },
          ]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-volume"),
      );
    });

    it("should display multiple volumes", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json([
            {
              name: "volume-one",
              size: 1024,
              fileCount: 10,
              updatedAt: new Date().toISOString(),
            },
            {
              name: "volume-two",
              size: 2048,
              fileCount: 20,
              updatedAt: new Date().toISOString(),
            },
          ]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("volume-one"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("volume-two"),
      );
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");
      // No token set

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to list volumes"),
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
        expect.stringContaining("Failed to list volumes"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("alias", () => {
    it("should work with ls alias", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/list", () => {
          return HttpResponse.json([]);
        }),
      );

      // The alias is registered on the command, so we can test the command has the alias
      expect(listCommand.alias()).toBe("ls");
    });
  });
});
