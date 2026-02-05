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
import prompts from "prompts";

describe("model-provider setup command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    // Save original TTY state
    originalIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();

    // Restore TTY state
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  describe("input validation", () => {
    it("should reject invalid provider type", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "invalid-type",
          "--secret",
          "test-secret",
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

    it("should reject when only --type is provided without --secret", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "anthropic-api-key",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Both --type and --secret are required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject when only --secret is provided without --type", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--secret",
          "test-secret",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Both --type and --secret are required"),
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
          "--secret",
          "test-secret",
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
              secretName: "ANTHROPIC_API_KEY",
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
        "--secret",
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
              secretName: "ANTHROPIC_API_KEY",
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
        "--secret",
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
          "--secret",
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
          "--secret",
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
          "--secret",
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
              secretName: "ANTHROPIC_API_KEY",
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
        "--secret",
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
                secretName: "MOONSHOT_API_KEY",
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
        "--secret",
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
          "--secret",
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
                secretName: "MOONSHOT_API_KEY",
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
        "--secret",
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
          "--secret",
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
                secretName: "OPENROUTER_API_KEY",
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
        "--secret",
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
                secretName: "OPENROUTER_API_KEY",
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
        "--secret",
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
          "--secret",
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
          "--secret",
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
              secretName: "ANTHROPIC_API_KEY",
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
        "--secret",
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
              secretName: "ANTHROPIC_API_KEY",
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
        "--secret",
        "sk-ant-test-key",
      ]);

      // Should show success message with default note
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Model provider "anthropic-api-key" created');
      expect(logCalls).toContain("default for claude-code");
    });
  });

  describe("interactive mode", () => {
    // Helper to enable interactive mode
    function enableInteractiveMode() {
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });
    }

    describe("provider type selection", () => {
      it("should prompt for provider type and secret in interactive mode", async () => {
        enableInteractiveMode();

        server.use(
          // listModelProviders for getting configured providers
          http.get("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({ modelProviders: [] });
          }),
          // checkModelProviderSecret
          http.get(
            "http://localhost:3000/api/model-providers/check/:type",
            () => {
              return HttpResponse.json({
                exists: false,
                secretName: "ANTHROPIC_API_KEY",
              });
            },
          ),
          // upsertModelProvider
          http.put("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({
              provider: {
                id: "mp-123",
                type: "anthropic-api-key",
                framework: "claude-code",
                secretName: "ANTHROPIC_API_KEY",
                isDefault: true,
                selectedModel: null,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
              },
              created: true,
            });
          }),
        );

        // Inject: provider type selection (anthropic-api-key is index 1)
        // Inject: secret input
        prompts.inject(["anthropic-api-key", "sk-ant-interactive-key"]);

        await setupCommand.parseAsync(["node", "cli"]);

        const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
        expect(logCalls).toContain(
          'Model provider "anthropic-api-key" created',
        );
        expect(logCalls).toContain("default for claude-code");
      });
    });

    describe("model selection", () => {
      it("should prompt for model selection for providers with models", async () => {
        enableInteractiveMode();

        server.use(
          http.get("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({ modelProviders: [] });
          }),
          http.get(
            "http://localhost:3000/api/model-providers/check/:type",
            () => {
              return HttpResponse.json({
                exists: false,
                secretName: "MOONSHOT_API_KEY",
              });
            },
          ),
          http.put(
            "http://localhost:3000/api/model-providers",
            async ({ request }) => {
              const body = (await request.json()) as { selectedModel?: string };
              return HttpResponse.json({
                provider: {
                  id: "mp-moonshot",
                  type: "moonshot-api-key",
                  framework: "claude-code",
                  secretName: "MOONSHOT_API_KEY",
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

        // Inject: provider type selection, secret, model selection
        prompts.inject([
          "moonshot-api-key",
          "sk-moonshot-interactive",
          "kimi-k2-thinking-turbo",
        ]);

        await setupCommand.parseAsync(["node", "cli"]);

        const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
        expect(logCalls).toContain('Model provider "moonshot-api-key" created');
        expect(logCalls).toContain("with model: kimi-k2-thinking-turbo");
      });

      it("should allow custom model input for providers that support it", async () => {
        enableInteractiveMode();

        server.use(
          http.get("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({ modelProviders: [] });
          }),
          http.get(
            "http://localhost:3000/api/model-providers/check/:type",
            () => {
              return HttpResponse.json({
                exists: false,
                secretName: "AWS_BEARER_TOKEN_BEDROCK",
              });
            },
          ),
          http.put(
            "http://localhost:3000/api/model-providers",
            async ({ request }) => {
              const body = (await request.json()) as { selectedModel?: string };
              return HttpResponse.json({
                provider: {
                  id: "mp-bedrock",
                  type: "aws-bedrock",
                  framework: "claude-code",
                  authMethod: "api-key",
                  secretNames: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"],
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

        // Inject: provider type, auth method, secrets (API key, region), model selection (__custom__), custom model input
        prompts.inject([
          "aws-bedrock",
          "api-key",
          "bedrock-api-key-123",
          "us-west-2",
          "__custom__",
          "anthropic.claude-sonnet-4-custom",
        ]);

        await setupCommand.parseAsync(["node", "cli"]);

        const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
        expect(logCalls).toContain('Model provider "aws-bedrock" created');
        expect(logCalls).toContain(
          "with model: anthropic.claude-sonnet-4-custom",
        );
      });
    });

    describe("multi-auth providers", () => {
      it("should prompt for auth method and multiple secrets for aws-bedrock", async () => {
        enableInteractiveMode();

        let capturedBody: {
          authMethod?: string;
          secrets?: Record<string, string>;
        } = {};

        server.use(
          http.get("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({ modelProviders: [] });
          }),
          http.get(
            "http://localhost:3000/api/model-providers/check/:type",
            () => {
              return HttpResponse.json({
                exists: false,
                secretName: "AWS_BEARER_TOKEN_BEDROCK",
              });
            },
          ),
          http.put(
            "http://localhost:3000/api/model-providers",
            async ({ request }) => {
              capturedBody = (await request.json()) as typeof capturedBody;
              return HttpResponse.json({
                provider: {
                  id: "mp-bedrock",
                  type: "aws-bedrock",
                  framework: "claude-code",
                  authMethod: capturedBody.authMethod,
                  secretNames: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"],
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

        // Inject: provider type, auth method (api-key), API key, region, model selection (auto)
        prompts.inject([
          "aws-bedrock",
          "api-key",
          "bedrock-api-key-value",
          "us-east-1",
          "",
        ]);

        await setupCommand.parseAsync(["node", "cli"]);

        expect(capturedBody.authMethod).toBe("api-key");
        expect(capturedBody.secrets).toEqual({
          AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key-value",
          AWS_REGION: "us-east-1",
        });

        const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
        expect(logCalls).toContain('Model provider "aws-bedrock" created');
      });

      it("should handle access-keys auth method with optional session token", async () => {
        enableInteractiveMode();

        let capturedBody: {
          authMethod?: string;
          secrets?: Record<string, string>;
        } = {};

        server.use(
          http.get("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({ modelProviders: [] });
          }),
          http.get(
            "http://localhost:3000/api/model-providers/check/:type",
            () => {
              return HttpResponse.json({
                exists: false,
                secretName: "AWS_ACCESS_KEY_ID",
              });
            },
          ),
          http.put(
            "http://localhost:3000/api/model-providers",
            async ({ request }) => {
              capturedBody = (await request.json()) as typeof capturedBody;
              return HttpResponse.json({
                provider: {
                  id: "mp-bedrock",
                  type: "aws-bedrock",
                  framework: "claude-code",
                  authMethod: capturedBody.authMethod,
                  secretNames: [
                    "AWS_ACCESS_KEY_ID",
                    "AWS_SECRET_ACCESS_KEY",
                    "AWS_REGION",
                  ],
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

        // Inject: provider type, auth method (access-keys), access key id, secret access key, session token (optional - empty), region, model (auto)
        prompts.inject([
          "aws-bedrock",
          "access-keys",
          "AKIAIOSFODNN7EXAMPLE",
          "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          "", // optional session token - skip
          "eu-west-1",
          "",
        ]);

        await setupCommand.parseAsync(["node", "cli"]);

        expect(capturedBody.authMethod).toBe("access-keys");
        expect(capturedBody.secrets?.AWS_ACCESS_KEY_ID).toBe(
          "AKIAIOSFODNN7EXAMPLE",
        );
        expect(capturedBody.secrets?.AWS_SECRET_ACCESS_KEY).toBe(
          "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        );
        expect(capturedBody.secrets?.AWS_REGION).toBe("eu-west-1");
        // Session token should not be present when empty
        expect(capturedBody.secrets?.AWS_SESSION_TOKEN).toBeUndefined();
      });
    });

    describe("existing secret flow", () => {
      it("should prompt to keep or update when secret already exists", async () => {
        enableInteractiveMode();

        server.use(
          http.get("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({
              modelProviders: [
                {
                  id: "mp-existing",
                  type: "anthropic-api-key",
                  framework: "claude-code",
                  secretName: "ANTHROPIC_API_KEY",
                  isDefault: true,
                  selectedModel: null,
                  createdAt: "2024-01-01T00:00:00Z",
                  updatedAt: "2024-01-01T00:00:00Z",
                },
              ],
            });
          }),
          http.get(
            "http://localhost:3000/api/model-providers/check/:type",
            () => {
              return HttpResponse.json({
                exists: true,
                secretName: "ANTHROPIC_API_KEY",
              });
            },
          ),
          // updateModelProviderModel for "keep" flow
          http.patch(
            "http://localhost:3000/api/model-providers/:type/model",
            () => {
              return HttpResponse.json({
                id: "mp-existing",
                type: "anthropic-api-key",
                framework: "claude-code",
                secretName: "ANTHROPIC_API_KEY",
                isDefault: true,
                selectedModel: null,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
              });
            },
          ),
        );

        // Inject: provider type, action (keep)
        prompts.inject(["anthropic-api-key", "keep"]);

        await setupCommand.parseAsync(["node", "cli"]);

        const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
        expect(logCalls).toContain('Model provider "anthropic-api-key"');
        expect(logCalls).toContain("unchanged");
      });

      it("should update secret when user chooses to update", async () => {
        enableInteractiveMode();

        server.use(
          http.get("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({
              modelProviders: [
                {
                  id: "mp-existing",
                  type: "anthropic-api-key",
                  framework: "claude-code",
                  secretName: "ANTHROPIC_API_KEY",
                  isDefault: true,
                  selectedModel: null,
                  createdAt: "2024-01-01T00:00:00Z",
                  updatedAt: "2024-01-01T00:00:00Z",
                },
              ],
            });
          }),
          http.get(
            "http://localhost:3000/api/model-providers/check/:type",
            () => {
              return HttpResponse.json({
                exists: true,
                secretName: "ANTHROPIC_API_KEY",
              });
            },
          ),
          http.put("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({
              provider: {
                id: "mp-existing",
                type: "anthropic-api-key",
                framework: "claude-code",
                secretName: "ANTHROPIC_API_KEY",
                isDefault: true,
                selectedModel: null,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-02T00:00:00Z",
              },
              created: false,
            });
          }),
        );

        // Inject: provider type, action (update), new secret
        prompts.inject([
          "anthropic-api-key",
          "update",
          "sk-ant-new-updated-key",
        ]);

        await setupCommand.parseAsync(["node", "cli"]);

        const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
        expect(logCalls).toContain(
          'Model provider "anthropic-api-key" updated',
        );
      });
    });

    describe("set as default prompt", () => {
      it("should prompt to set as default when provider is not default", async () => {
        enableInteractiveMode();

        server.use(
          http.get("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({ modelProviders: [] });
          }),
          http.get(
            "http://localhost:3000/api/model-providers/check/:type",
            () => {
              return HttpResponse.json({
                exists: false,
                secretName: "ANTHROPIC_API_KEY",
              });
            },
          ),
          http.put("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({
              provider: {
                id: "mp-456",
                type: "anthropic-api-key",
                framework: "claude-code",
                secretName: "ANTHROPIC_API_KEY",
                isDefault: false,
                selectedModel: null,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
              },
              created: true,
            });
          }),
          http.post(
            "http://localhost:3000/api/model-providers/:type/set-default",
            () => {
              return HttpResponse.json({
                id: "mp-456",
                type: "anthropic-api-key",
                framework: "claude-code",
                secretName: "ANTHROPIC_API_KEY",
                isDefault: true,
                selectedModel: null,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
              });
            },
          ),
        );

        // Inject: provider type, secret, set as default (yes)
        prompts.inject(["anthropic-api-key", "sk-ant-key", true]);

        await setupCommand.parseAsync(["node", "cli"]);

        const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
        expect(logCalls).toContain(
          'Model provider "anthropic-api-key" created',
        );
        expect(logCalls).toContain(
          'Default for claude-code set to "anthropic-api-key"',
        );
      });

      it("should not set as default when user declines", async () => {
        enableInteractiveMode();

        let setDefaultCalled = false;

        server.use(
          http.get("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({ modelProviders: [] });
          }),
          http.get(
            "http://localhost:3000/api/model-providers/check/:type",
            () => {
              return HttpResponse.json({
                exists: false,
                secretName: "ANTHROPIC_API_KEY",
              });
            },
          ),
          http.put("http://localhost:3000/api/model-providers", () => {
            return HttpResponse.json({
              provider: {
                id: "mp-456",
                type: "anthropic-api-key",
                framework: "claude-code",
                secretName: "ANTHROPIC_API_KEY",
                isDefault: false,
                selectedModel: null,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
              },
              created: true,
            });
          }),
          http.post(
            "http://localhost:3000/api/model-providers/:type/set-default",
            () => {
              setDefaultCalled = true;
              return HttpResponse.json({
                id: "mp-456",
                type: "anthropic-api-key",
                framework: "claude-code",
                secretName: "ANTHROPIC_API_KEY",
                isDefault: true,
                selectedModel: null,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
              });
            },
          ),
        );

        // Inject: provider type, secret, set as default (no)
        prompts.inject(["anthropic-api-key", "sk-ant-key", false]);

        await setupCommand.parseAsync(["node", "cli"]);

        expect(setDefaultCalled).toBe(false);
        const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
        expect(logCalls).toContain(
          'Model provider "anthropic-api-key" created',
        );
        expect(logCalls).not.toContain("Default for claude-code set to");
      });
    });
  });
});
