/**
 * Unit tests for model-provider command validation and help text
 *
 * These tests validate model provider type validation rules and help text output.
 * They replace E2E tests that tested the same behavior through the full stack.
 *
 * Key behaviors tested:
 * - Invalid type rejection for setup, delete, and set-default commands
 * - Non-existent provider deletion error handling
 * - Non-existent provider set-default error handling
 * - Help text smoke test (consolidated from 5 E2E help tests)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { modelProviderCommand } from "../commands/model-provider/index";
import { setupCommand } from "../commands/model-provider/setup";
import { deleteCommand } from "../commands/model-provider/delete";
import { setDefaultCommand } from "../commands/model-provider/set-default";
import chalk from "chalk";

describe("Model Provider Command", () => {
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

  describe("help text smoke test", () => {
    it("model-provider --help shows command description and subcommands", async () => {
      // Commander outputs help to stdout via process.stdout.write
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await modelProviderCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      // Main command description
      expect(output).toContain("Manage model providers");

      // Subcommands should be listed
      expect(output).toContain("ls");
      expect(output).toContain("setup");
      expect(output).toContain("delete");
      expect(output).toContain("set-default");

      mockStdoutWrite.mockRestore();
    });
  });

  describe("invalid type rejection", () => {
    it("setup rejects invalid provider type", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "invalid-type",
          "--credential",
          "test-credential",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid type "invalid-type"'),
      );
      // Should show valid types
      expect(mockConsoleLog).toHaveBeenCalledWith("Valid types:");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("delete rejects invalid provider type", async () => {
      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "invalid-type"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid type "invalid-type"'),
      );
      // Should show valid types
      expect(mockConsoleLog).toHaveBeenCalledWith("Valid types:");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("set-default rejects invalid provider type", async () => {
      await expect(async () => {
        await setDefaultCommand.parseAsync(["node", "cli", "invalid-type"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid type "invalid-type"'),
      );
      // Should show valid types
      expect(mockConsoleLog).toHaveBeenCalledWith("Valid types:");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("non-existent provider errors", () => {
    it("delete fails for non-existent provider", async () => {
      server.use(
        http.delete(
          "http://localhost:3000/api/model-providers/:type",
          ({ params }) => {
            const { type } = params;
            return HttpResponse.json(
              {
                error: {
                  message: `Model provider "${type}" not found`,
                  code: "NOT_FOUND",
                },
              },
              { status: 404 },
            );
          },
        ),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "anthropic-api-key"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("set-default fails for non-existent provider", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/model-providers/:type/set-default",
          ({ params }) => {
            const { type } = params;
            return HttpResponse.json(
              {
                error: {
                  message: `Model provider "${type}" not found`,
                  code: "NOT_FOUND",
                },
              },
              { status: 404 },
            );
          },
        ),
      );

      await expect(async () => {
        await setDefaultCommand.parseAsync([
          "node",
          "cli",
          "anthropic-api-key",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("authentication errors", () => {
    it("handles not authenticated error for setup", async () => {
      server.use(
        http.put("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Not authenticated",
                code: "UNAUTHORIZED",
              },
            },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "anthropic-api-key",
          "--credential",
          "test-key",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("handles not authenticated error for delete", async () => {
      server.use(
        http.delete("http://localhost:3000/api/model-providers/:type", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Not authenticated",
                code: "UNAUTHORIZED",
              },
            },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "anthropic-api-key"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("handles not authenticated error for set-default", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/model-providers/:type/set-default",
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Not authenticated",
                  code: "UNAUTHORIZED",
                },
              },
              { status: 401 },
            );
          },
        ),
      );

      await expect(async () => {
        await setDefaultCommand.parseAsync([
          "node",
          "cli",
          "anthropic-api-key",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
