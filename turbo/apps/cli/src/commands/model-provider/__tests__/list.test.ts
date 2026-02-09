/**
 * Tests for model-provider list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

describe("model-provider list command", () => {
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

  afterEach(() => {});

  describe("successful list", () => {
    it("should list model providers grouped by framework", async () => {
      server.use(
        http.get("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({
            modelProviders: [
              {
                id: "1",
                type: "anthropic-api-key",
                framework: "claude-code",
                selectedModel: "claude-sonnet-4-5-20250514",
                isDefault: true,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
              {
                id: "2",
                type: "aws-bedrock",
                framework: "claude-code",
                selectedModel: null,
                isDefault: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
              {
                id: "3",
                type: "openai-api-key",
                framework: "codex",
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
      // Check header
      expect(logCalls).toContain("Model Providers");
      // Check framework grouping
      expect(logCalls).toContain("claude-code");
      expect(logCalls).toContain("codex");
      // Check provider types
      expect(logCalls).toContain("anthropic-api-key");
      expect(logCalls).toContain("aws-bedrock");
      expect(logCalls).toContain("openai-api-key");
      // Check default indicator
      expect(logCalls).toContain("(default)");
      // Check selected model
      expect(logCalls).toContain("claude-sonnet-4-5-20250514");
      expect(logCalls).toContain("gpt-4");
      // Check total count
      expect(logCalls).toContain("3 provider(s)");
    });

    it("should show empty state when no providers configured", async () => {
      server.use(
        http.get("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({ modelProviders: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No model providers configured");
      expect(logCalls).toContain("vm0 model-provider setup");
    });

    it("should show single provider without default tag", async () => {
      server.use(
        http.get("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({
            modelProviders: [
              {
                id: "1",
                type: "anthropic-api-key",
                framework: "claude-code",
                selectedModel: null,
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
      expect(logCalls).toContain("anthropic-api-key");
      expect(logCalls).not.toContain("(default)");
      expect(logCalls).toContain("1 provider(s)");
    });

    it("should handle provider without selected model", async () => {
      server.use(
        http.get("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({
            modelProviders: [
              {
                id: "1",
                type: "aws-bedrock",
                framework: "claude-code",
                selectedModel: null,
                isDefault: true,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("aws-bedrock");
      expect(logCalls).toContain("(default)");
      // Should not show model brackets when selectedModel is null
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/model-providers", () => {
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
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle generic API error", async () => {
      server.use(
        http.get("http://localhost:3000/api/model-providers", () => {
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
