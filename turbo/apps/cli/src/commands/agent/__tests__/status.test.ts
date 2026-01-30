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
});
