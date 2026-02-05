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

    it("should handle API error", async () => {
      server.use(
        http.put("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Something went wrong",
                code: "BAD_REQUEST",
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
        expect.stringContaining("Something went wrong"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle not authenticated error", async () => {
      server.use(
        http.put("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
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
              selectedModel: null,
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

  describe("model selection (moonshot-api-key)", () => {
    it("should create provider with specified model", async () => {
      server.use(
        http.put(
          "http://localhost:3000/api/model-providers",
          async ({ request }) => {
            const body = (await request.json()) as { selectedModel?: string };
            return HttpResponse.json({
              provider: {
                id: "mp-moonshot",
                type: "moonshot-api-key",
                framework: "claude-code",
                credentialName: "MOONSHOT_API_KEY",
                isDefault: true,
                selectedModel: body.selectedModel,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
              },
              created: true,
            });
          },
        ),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "--type",
        "moonshot-api-key",
        "--credential",
        "sk-moonshot-key",
        "--model",
        "kimi-k2.5",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("with model: kimi-k2.5"),
      );
    });

    it("should reject invalid model for moonshot-api-key", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "moonshot-api-key",
          "--credential",
          "sk-moonshot-key",
          "--model",
          "invalid-model",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid model "invalid-model"'),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Valid models:"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should use default model when --model not provided for moonshot-api-key", async () => {
      let capturedSelectedModel: string | undefined;
      server.use(
        http.put(
          "http://localhost:3000/api/model-providers",
          async ({ request }) => {
            const body = (await request.json()) as { selectedModel?: string };
            capturedSelectedModel = body.selectedModel;
            return HttpResponse.json({
              provider: {
                id: "mp-moonshot",
                type: "moonshot-api-key",
                framework: "claude-code",
                credentialName: "MOONSHOT_API_KEY",
                isDefault: true,
                selectedModel: body.selectedModel,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
              },
              created: true,
            });
          },
        ),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "--type",
        "moonshot-api-key",
        "--credential",
        "sk-moonshot-key",
      ]);

      // Should use default model (kimi-k2.5)
      expect(capturedSelectedModel).toBe("kimi-k2.5");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('Model provider "moonshot-api-key" created'),
      );
    });

    it("should list valid models when invalid model is provided", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "moonshot-api-key",
          "--credential",
          "sk-moonshot-key",
          "--model",
          "not-a-valid-model",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should show valid models
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("kimi-k2.5"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("kimi-k2-thinking-turbo"),
      );
    });
  });

  describe("openrouter-api-key (auto mode)", () => {
    it("should accept --type openrouter-api-key without --model (auto mode)", async () => {
      let capturedSelectedModel: string | undefined;
      server.use(
        http.put(
          "http://localhost:3000/api/model-providers",
          async ({ request }) => {
            const body = (await request.json()) as { selectedModel?: string };
            capturedSelectedModel = body.selectedModel;
            return HttpResponse.json({
              provider: {
                id: "mp-openrouter",
                type: "openrouter-api-key",
                framework: "claude-code",
                credentialName: "OPENROUTER_API_KEY",
                isDefault: true,
                selectedModel: null,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
              },
              created: true,
            });
          },
        ),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "--type",
        "openrouter-api-key",
        "--credential",
        "sk-or-xxx",
      ]);

      // In auto mode, selectedModel should be undefined (not sent to API)
      expect(capturedSelectedModel).toBeUndefined();
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('Model provider "openrouter-api-key" created'),
      );
    });

    it("should accept explicit model selection", async () => {
      let capturedSelectedModel: string | undefined;
      server.use(
        http.put(
          "http://localhost:3000/api/model-providers",
          async ({ request }) => {
            const body = (await request.json()) as { selectedModel?: string };
            capturedSelectedModel = body.selectedModel;
            return HttpResponse.json({
              provider: {
                id: "mp-openrouter",
                type: "openrouter-api-key",
                framework: "claude-code",
                credentialName: "OPENROUTER_API_KEY",
                isDefault: true,
                selectedModel: body.selectedModel,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
              },
              created: true,
            });
          },
        ),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "--type",
        "openrouter-api-key",
        "--credential",
        "sk-or-xxx",
        "--model",
        "anthropic/claude-sonnet-4.5",
      ]);

      expect(capturedSelectedModel).toBe("anthropic/claude-sonnet-4.5");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("with model: anthropic/claude-sonnet-4.5"),
      );
    });

    it("should reject invalid model for openrouter-api-key", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "openrouter-api-key",
          "--credential",
          "sk-or-xxx",
          "--model",
          "invalid/model",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid model "invalid/model"'),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Valid models:"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should list valid models when invalid model provided", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "openrouter-api-key",
          "--credential",
          "sk-or-xxx",
          "--model",
          "not-valid",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should show available Anthropic models
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("anthropic/claude-sonnet-4.5"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("anthropic/claude-opus-4.5"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("anthropic/claude-haiku-4.5"),
      );
    });
  });

  describe("set as default prompt (non-interactive mode)", () => {
    it("should NOT prompt to set as default in non-interactive mode when isDefault is false", async () => {
      server.use(
        http.put("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({
            provider: {
              id: "mp-456",
              type: "anthropic-api-key",
              framework: "claude-code",
              credentialName: "ANTHROPIC_API_KEY",
              isDefault: false,
              selectedModel: null,
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

      // Should show success message
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Model provider "anthropic-api-key" created');
      // Should NOT contain the "Set this provider as default?" prompt or its result
      // (in non-interactive mode, prompts would throw/hang, but we just verify no default message)
      expect(logCalls).not.toContain("Default for claude-code set to");
    });

    it("should complete without prompt when isDefault is true in non-interactive mode", async () => {
      server.use(
        http.put("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({
            provider: {
              id: "mp-123",
              type: "anthropic-api-key",
              framework: "claude-code",
              credentialName: "ANTHROPIC_API_KEY",
              isDefault: true,
              selectedModel: null,
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

      // Should show success message with default note
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Model provider "anthropic-api-key" created');
      expect(logCalls).toContain("default for claude-code");
    });
  });
});
