/**
 * Tests for zero org model-provider list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

describe("zero org model-provider list command", () => {
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

  describe("successful list", () => {
    it("should list org model providers grouped by framework", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/model-providers", () => {
          return HttpResponse.json({
            modelProviders: [
              {
                id: "1",
                type: "anthropic-api-key",
                framework: "claude-code",
                selectedModel: "claude-sonnet-4-5-20250514",
                isDefault: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
              {
                id: "2",
                type: "openai-api-key",
                framework: "claude-code",
                selectedModel: "gpt-4",
                isDefault: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Org Model Providers");
      expect(logCalls).toContain("claude-code");
      expect(logCalls).toContain("anthropic-api-key");
      expect(logCalls).toContain("openai-api-key");
      expect(logCalls).not.toContain("(default)");
      expect(logCalls).not.toContain("claude-sonnet-4-5-20250514");
      expect(logCalls).not.toContain("gpt-4");
      expect(logCalls).toContain("2 provider(s)");
    });

    it("should show empty state when no org providers configured", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/model-providers", () => {
          return HttpResponse.json({ modelProviders: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No org-level model providers configured");
      expect(logCalls).toContain("zero org model-provider setup");
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/model-providers", () => {
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
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle generic API error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/model-providers", () => {
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
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Internal server error"),
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
