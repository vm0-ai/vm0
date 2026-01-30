/**
 * Tests for agent status command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { statusCommand } from "../status";

describe("agent status command", () => {
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

  describe("successful status", () => {
    it("should display compose details", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "my-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "my-agent",
              headVersionId:
                "abc123def456789012345678901234567890123456789012345678901234",
              content: {
                version: "1.0",
                agents: {
                  "test-agent": {
                    framework: "claude-code",
                    working_dir: "/workspace",
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--no-sources",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Name:");
      expect(logCalls).toContain("my-agent");
      expect(logCalls).toContain("Version:");
      expect(logCalls).toContain("Agents:");
      expect(logCalls).toContain("test-agent");
      expect(logCalls).toContain("Framework:");
      expect(logCalls).toContain("claude-code");
    });

    it("should parse name:version format", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "my-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "my-agent",
              headVersionId:
                "abc123def456789012345678901234567890123456789012345678901234",
              content: {
                version: "1.0",
                agents: {
                  "test-agent": {
                    framework: "claude-code",
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
        http.get(
          "http://localhost:3000/api/agent/composes/versions",
          ({ request }) => {
            const url = new URL(request.url);
            if (url.searchParams.get("version") === "abc12345") {
              return HttpResponse.json({
                versionId:
                  "abc123def456789012345678901234567890123456789012345678901234",
              });
            }
            return HttpResponse.json(
              { error: { message: "Version not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "my-agent:abc12345",
        "--no-sources",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-agent");
    });
  });

  describe("error handling", () => {
    it("should exit with error when compose not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Compose not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await statusCommand.parseAsync([
          "node",
          "cli",
          "nonexistent-agent",
          "--no-sources",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Compose not found"),
      );
    });

    it("should exit with error when version not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "my-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "my-agent",
              headVersionId:
                "abc123def456789012345678901234567890123456789012345678901234",
              content: {
                version: "1.0",
                agents: { "test-agent": { framework: "claude-code" } },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
        http.get("http://localhost:3000/api/agent/composes/versions", () => {
          return HttpResponse.json(
            { error: { message: "Version not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await statusCommand.parseAsync([
          "node",
          "cli",
          "my-agent:badversi",
          "--no-sources",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Version not found"),
      );
    });

    it("should handle authentication error", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");
      // No token set

      await expect(async () => {
        await statusCommand.parseAsync([
          "node",
          "cli",
          "my-agent",
          "--no-sources",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to get agent compose status"),
      );
    });
  });

  describe("variable source derivation", () => {
    it("should display environment variables with source info when --no-sources used", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "my-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "my-agent",
              headVersionId:
                "abc123def456789012345678901234567890123456789012345678901234",
              content: {
                version: "1.0",
                agents: {
                  "test-agent": {
                    framework: "claude-code",
                    working_dir: "/workspace",
                    environment: {
                      API_KEY: "${{ secrets.OPENAI_API_KEY }}",
                      DEBUG_MODE: "${{ vars.DEBUG_MODE }}",
                      GITHUB_CRED: "${{ credentials.GITHUB_APP }}",
                    },
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--no-sources",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");

      // Should display secrets section
      expect(logCalls).toContain("Secrets:");
      expect(logCalls).toContain("OPENAI_API_KEY");
      expect(logCalls).toContain("agent environment");

      // Should display vars section
      expect(logCalls).toContain("Vars:");
      expect(logCalls).toContain("DEBUG_MODE");

      // Should display credentials section
      expect(logCalls).toContain("Credentials:");
      expect(logCalls).toContain("GITHUB_APP");
    });

    it("should display multiple secrets and vars from compose", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "multi-var-agent") {
            return HttpResponse.json({
              id: "cmp-456",
              name: "multi-var-agent",
              headVersionId:
                "def456abc789012345678901234567890123456789012345678901234567",
              content: {
                version: "1.0",
                agents: {
                  "multi-agent": {
                    framework: "claude-code",
                    working_dir: "/workspace",
                    environment: {
                      SECRET_A: "${{ secrets.SECRET_ONE }}",
                      SECRET_B: "${{ secrets.SECRET_TWO }}",
                      VAR_A: "${{ vars.CONFIG_VALUE }}",
                      VAR_B: "${{ vars.FEATURE_FLAG }}",
                    },
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "multi-var-agent",
        "--no-sources",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");

      // Should display all secrets
      expect(logCalls).toContain("SECRET_ONE");
      expect(logCalls).toContain("SECRET_TWO");

      // Should display all vars
      expect(logCalls).toContain("CONFIG_VALUE");
      expect(logCalls).toContain("FEATURE_FLAG");
    });

    it("should display agent with no environment variables", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "simple-agent") {
            return HttpResponse.json({
              id: "cmp-789",
              name: "simple-agent",
              headVersionId:
                "ghi789abc012345678901234567890123456789012345678901234567890",
              content: {
                version: "1.0",
                agents: {
                  "basic-agent": {
                    framework: "claude-code",
                    working_dir: "/workspace",
                    // No environment variables
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "simple-agent",
        "--no-sources",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");

      // Should not display secrets/vars sections when none exist
      expect(logCalls).not.toContain("Secrets:");
      expect(logCalls).not.toContain("Vars:");
      expect(logCalls).not.toContain("Credentials:");

      // Should still show basic info
      expect(logCalls).toContain("Name:");
      expect(logCalls).toContain("simple-agent");
      expect(logCalls).toContain("Framework:");
      expect(logCalls).toContain("claude-code");
    });
  });
});
