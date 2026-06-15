/**
 * Tests for zero org model-provider setup command (non-interactive mode)
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 *
 * Interactive mode helpers are tested via model-provider/setup.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { setupCommand } from "../setup";

describe("zero org model-provider setup command", () => {
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

  describe("non-interactive mode", () => {
    it("should create single-secret provider", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/model-providers", () => {
          return HttpResponse.json(
            {
              provider: {
                id: "1",
                type: "anthropic-api-key",
                framework: "claude-code",
                isDefault: false,
                selectedModel: null,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
              created: true,
            },
            { status: 201 },
          );
        }),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "--type",
        "anthropic-api-key",
        "--secret",
        "sk-ant-test123",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining(
          'Org model provider "anthropic-api-key" created',
        ),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should create provider without provider-level model selection", async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post(
          "http://localhost:3000/api/zero/model-providers",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(
              {
                provider: {
                  id: "1",
                  type: "moonshot-api-key",
                  framework: "claude-code",
                  isDefault: false,
                  selectedModel: null,
                  createdAt: "2025-01-01T00:00:00Z",
                  updatedAt: "2025-01-01T00:00:00Z",
                },
                created: true,
              },
              { status: 201 },
            );
          },
        ),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "--type",
        "moonshot-api-key",
        "--secret",
        "sk-test",
      ]);

      expect(capturedBody).not.toHaveProperty("selectedModel");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining(
          'Org model provider "moonshot-api-key" created',
        ),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should update existing provider", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/model-providers", () => {
          return HttpResponse.json({
            provider: {
              id: "1",
              type: "anthropic-api-key",
              framework: "claude-code",
              isDefault: false,
              selectedModel: null,
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-01T00:00:00Z",
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
        "sk-ant-updated",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining(
          'Org model provider "anthropic-api-key" updated',
        ),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe("input validation", () => {
    it("should require both --type and --secret", async () => {
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

    it("should reject invalid provider type", async () => {
      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "--type",
          "invalid-type",
          "--secret",
          "sk-test",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid type "invalid-type"'),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle forbidden error for non-admin", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/model-providers", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Admin access required",
                code: "FORBIDDEN",
              },
            },
            { status: 403 },
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
          "sk-ant-test",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Admin access required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle authentication error", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/model-providers", () => {
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
          "--secret",
          "sk-ant-test",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
