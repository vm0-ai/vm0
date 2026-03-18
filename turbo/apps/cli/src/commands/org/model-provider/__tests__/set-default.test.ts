/**
 * Tests for org model-provider set-default command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { setDefaultCommand } from "../set-default";

describe("org model-provider set-default command", () => {
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

  describe("successful set-default", () => {
    it("should show success message with framework", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/org/model-providers/:type/set-default",
          () => {
            return HttpResponse.json({
              id: "1",
              type: "anthropic-api-key",
              framework: "claude-code",
              isDefault: true,
              selectedModel: null,
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-01T00:00:00Z",
            });
          },
        ),
      );

      await setDefaultCommand.parseAsync(["node", "cli", "anthropic-api-key"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining(
          'Default for claude-code set to "anthropic-api-key"',
        ),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe("input validation", () => {
    it("should reject invalid provider type", async () => {
      await expect(async () => {
        await setDefaultCommand.parseAsync(["node", "cli", "invalid-type"]);
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
        http.post(
          "http://localhost:3000/api/org/model-providers/:type/set-default",
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

    it("should handle forbidden error for non-admin", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/org/model-providers/:type/set-default",
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
        await setDefaultCommand.parseAsync([
          "node",
          "cli",
          "anthropic-api-key",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Admin access required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
