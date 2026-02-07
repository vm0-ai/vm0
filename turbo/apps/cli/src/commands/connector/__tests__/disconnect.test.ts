/**
 * Tests for connector disconnect command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { disconnectCommand } from "../disconnect";
import chalk from "chalk";

describe("connector disconnect command", () => {
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
    vi.unstubAllEnvs();
  });

  describe("successful disconnect", () => {
    it("should show success message on successful disconnect", async () => {
      server.use(
        http.delete("http://localhost:3000/api/connectors/:type", () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await disconnectCommand.parseAsync(["node", "cli", "github"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Disconnected github"),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe("input validation", () => {
    it("should reject invalid connector type", async () => {
      await expect(async () => {
        await disconnectCommand.parseAsync(["node", "cli", "invalid-type"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unknown connector type: invalid-type"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Available connectors:"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle not connected error (404)", async () => {
      server.use(
        http.delete("http://localhost:3000/api/connectors/:type", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Connector not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await disconnectCommand.parseAsync(["node", "cli", "github"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("is not connected"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle authentication error", async () => {
      server.use(
        http.delete("http://localhost:3000/api/connectors/:type", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await disconnectCommand.parseAsync(["node", "cli", "github"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle generic API error", async () => {
      server.use(
        http.delete("http://localhost:3000/api/connectors/:type", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Internal server error",
                code: "SERVER_ERROR",
              },
            },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await disconnectCommand.parseAsync(["node", "cli", "github"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Internal server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
