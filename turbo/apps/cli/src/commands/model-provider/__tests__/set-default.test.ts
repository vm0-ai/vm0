/**
 * Tests for model-provider set-default command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { setDefaultCommand } from "../set-default";

describe("model-provider set-default command", () => {
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
    vi.unstubAllEnvs();
  });

  describe("successful set-default", () => {
    it("should show success message on successful set-default", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/model-providers/:type/set-default",
          () => {
            return HttpResponse.json({
              id: "test-id",
              type: "anthropic-api-key",
              framework: "claude-code",
              credentialName: "ANTHROPIC_API_KEY",
              isDefault: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          },
        ),
      );

      await setDefaultCommand.parseAsync(["node", "cli", "anthropic-api-key"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("anthropic-api-key"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Default"),
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
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Valid types:"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle not found error", async () => {
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

    it("should handle authentication error", async () => {
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
