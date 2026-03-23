/**
 * Tests for zero org model-provider remove command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { removeCommand } from "../remove";

describe("zero org model-provider remove command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  describe("successful removal", () => {
    it("should show success message on successful removal", async () => {
      server.use(
        http.delete(
          "http://localhost:3000/api/zero/model-providers/:type",
          () => {
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );

      await removeCommand.parseAsync(["node", "cli", "anthropic-api-key"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining(
          'Org model provider "anthropic-api-key" removed',
        ),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe("input validation", () => {
    it("should reject invalid provider type", async () => {
      await expect(async () => {
        await removeCommand.parseAsync(["node", "cli", "invalid-type"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid type "invalid-type"'),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Valid types:"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle not found error", async () => {
      server.use(
        http.delete(
          "http://localhost:3000/api/zero/model-providers/:type",
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Model provider not found",
                  code: "NOT_FOUND",
                },
              },
              { status: 404 },
            );
          },
        ),
      );

      await expect(async () => {
        await removeCommand.parseAsync(["node", "cli", "anthropic-api-key"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle forbidden error for non-admin", async () => {
      server.use(
        http.delete(
          "http://localhost:3000/api/zero/model-providers/:type",
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Admin access required",
                  code: "FORBIDDEN",
                },
              },
              { status: 403 },
            );
          },
        ),
      );

      await expect(async () => {
        await removeCommand.parseAsync(["node", "cli", "anthropic-api-key"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Admin access required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle authentication error", async () => {
      server.use(
        http.delete(
          "http://localhost:3000/api/zero/model-providers/:type",
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
        await removeCommand.parseAsync(["node", "cli", "anthropic-api-key"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
