/**
 * Tests for model-provider setup command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { setupCommand } from "../setup";
import { MODEL_PROVIDER_TYPES } from "@vm0/core";

describe("model-provider setup command", () => {
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
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("input validation", () => {
    it("should reject invalid provider type", async () => {
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
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Valid types:"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject when only --type is provided without --credential", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "anthropic-api-key",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Both --type and --credential are required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject when only --credential is provided without --type", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--credential",
          "test-credential",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Both --type and --credential are required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should list valid types when invalid type is provided", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "not-a-real-type",
          "--credential",
          "test-credential",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should show anthropic-api-key as a valid type
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("anthropic-api-key"),
      );
    });
  });

  describe("help text configuration", () => {
    it("should have helpText defined for all provider types", () => {
      for (const config of Object.values(MODEL_PROVIDER_TYPES)) {
        expect(config.helpText).toBeDefined();
        expect(config.helpText.length).toBeGreaterThan(0);
      }
    });

    it("should have correct helpText for claude-code-oauth-token", () => {
      const config = MODEL_PROVIDER_TYPES["claude-code-oauth-token"];
      expect(config.helpText).toContain("claude setup-token");
      expect(config.helpText).toContain("Claude Pro or Max subscription");
    });

    it("should have correct helpText for anthropic-api-key", () => {
      const config = MODEL_PROVIDER_TYPES["anthropic-api-key"];
      expect(config.helpText).toContain("console.anthropic.com");
    });
  });

  describe("API integration", () => {
    it("should create model provider successfully", async () => {
      server.use(
        http.put("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({
            provider: {
              id: "mp-123",
              type: "anthropic-api-key",
              framework: "claude-code",
              credentialName: "ANTHROPIC_API_KEY",
              isDefault: true,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
            created: true,
          });
        }),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "--type",
        "anthropic-api-key",
        "--credential",
        "sk-ant-test-key",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('Model provider "anthropic-api-key" created'),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("default for claude-code"),
      );
    });

    it("should update existing model provider", async () => {
      server.use(
        http.put("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({
            provider: {
              id: "mp-123",
              type: "anthropic-api-key",
              framework: "claude-code",
              credentialName: "ANTHROPIC_API_KEY",
              isDefault: true,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-02T00:00:00Z",
            },
            created: false,
          });
        }),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "--type",
        "anthropic-api-key",
        "--credential",
        "sk-ant-new-key",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('Model provider "anthropic-api-key" updated'),
      );
    });

    it("should handle credential already exists error", async () => {
      server.use(
        http.put("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json(
            {
              error: {
                message:
                  'Credential "ANTHROPIC_API_KEY" already exists as user credential',
                code: "CREDENTIAL_EXISTS",
              },
            },
            { status: 400 },
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
          "sk-ant-test-key",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("already exists"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 model-provider setup --convert"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle not authenticated error", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");
      // No token set

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "anthropic-api-key",
          "--credential",
          "sk-ant-test-key",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle generic API error", async () => {
      server.use(
        http.put("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Internal server error",
                code: "INTERNAL_ERROR",
              },
            },
            { status: 500 },
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
          "sk-ant-test-key",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Internal server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show provider without default note when not default", async () => {
      server.use(
        http.put("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({
            provider: {
              id: "mp-456",
              type: "anthropic-api-key",
              framework: "claude-code",
              credentialName: "ANTHROPIC_API_KEY",
              isDefault: false,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
            created: true,
          });
        }),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "--type",
        "anthropic-api-key",
        "--credential",
        "sk-ant-test-key",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Model provider "anthropic-api-key" created');
      expect(logCalls).not.toContain("default for");
    });
  });
});
