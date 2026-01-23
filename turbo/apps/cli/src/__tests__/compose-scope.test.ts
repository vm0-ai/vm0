/**
 * Unit tests for compose scope error handling
 *
 * These tests validate error handling for scope-based agent resolution that was
 * previously tested via E2E tests in t22-vm0-compose-scope.bats. Moving these to
 * unit tests improves test performance and provides faster feedback during
 * development.
 *
 * Key behaviors tested:
 * - Non-existent scope shows proper error
 * - Non-existent agent in valid scope shows proper error
 * - Non-existent version shows proper error
 * - Cross-scope isolation (cannot access agent from different scope)
 *
 * Note: Integration tests for successful run operations remain in E2E tests
 * since they require actual compose/run interactions with the API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { runCommand } from "../commands/run";
import chalk from "chalk";

describe("Compose Scope Error Handling", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    // Disable chalk colors for deterministic console output assertions
    chalk.level = 0;
    // Use environment variables for config instead of mocking the module
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("Non-existent scope error", () => {
    it("should show error when scope does not exist", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          const scope = url.searchParams.get("scope");

          // Non-existent scope returns 404
          if (scope === "nonexistent-scope-xyz123") {
            return HttpResponse.json(
              {
                error: {
                  message: "Scope not found: nonexistent-scope-xyz123",
                  code: "NOT_FOUND",
                },
              },
              { status: 404 },
            );
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "nonexistent-scope-xyz123/my-agent",
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should show error indicating the scope/agent was not found
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should provide helpful error message for non-existent scope", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Scope not found: invalid-scope",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "invalid-scope/test-agent",
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      // Error message should indicate the agent was not found
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Agent not found"),
      );
      // Should suggest creating a compose
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 compose"),
      );
    });
  });

  describe("Non-existent agent in valid scope error", () => {
    it("should show error when agent does not exist in valid scope", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          const name = url.searchParams.get("name");
          const scope = url.searchParams.get("scope");

          // Valid scope but agent doesn't exist
          if (
            scope === "user-abc12345" &&
            name === "nonexistent-agent-xyz123"
          ) {
            return HttpResponse.json(
              {
                error: {
                  message:
                    "Compose not found: nonexistent-agent-xyz123 in scope user-abc12345",
                  code: "NOT_FOUND",
                },
              },
              { status: 404 },
            );
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "user-abc12345/nonexistent-agent-xyz123",
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should show error indicating the agent was not found
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Agent not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should suggest creating a compose when agent not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Compose not found: missing-agent",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "user-scope/missing-agent",
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should suggest using vm0 compose
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 compose"),
      );
    });
  });

  describe("Non-existent version error", () => {
    it("should show error when version does not exist", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          const name = url.searchParams.get("name");
          const scope = url.searchParams.get("scope");

          // Agent exists
          if (scope === "user-abc12345" && name === "my-agent") {
            return HttpResponse.json({
              id: "550e8400-e29b-41d4-a716-446655440000",
              name: "my-agent",
              headVersionId:
                "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
              content: {
                version: "1",
                agents: { main: { provider: "claude" } },
              },
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-01T00:00:00Z",
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.get("http://localhost:3000/api/agent/composes/versions", () => {
          // Version doesn't exist
          return HttpResponse.json(
            {
              error: {
                message: "Version not found: deadbeef",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "user-abc12345/my-agent:deadbeef",
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should show version not found error
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Version not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should include the version in the error message", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            id: "550e8400-e29b-41d4-a716-446655440000",
            name: "my-agent",
            headVersionId:
              "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
            content: { version: "1", agents: { main: { provider: "claude" } } },
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          });
        }),
        http.get("http://localhost:3000/api/agent/composes/versions", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Version not found: 12345678",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "user-abc12345/my-agent:12345678",
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      // Error message should include the version that wasn't found
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("12345678"),
      );
    });
  });

  describe("Cross-scope isolation", () => {
    it("should not allow access to agent from different scope", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          const name = url.searchParams.get("name");
          const scope = url.searchParams.get("scope");

          // Trying to access agent with wrong scope
          if (scope === "other-user-scope" && name === "my-agent") {
            return HttpResponse.json(
              {
                error: {
                  message:
                    "Compose not found: my-agent in scope other-user-scope",
                  code: "NOT_FOUND",
                },
              },
              { status: 404 },
            );
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "other-user-scope/my-agent",
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should show agent not found error (scope isolation means agent appears not to exist)
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should treat scope isolation as not found rather than forbidden", async () => {
      // Security best practice: don't leak information about existence of resources
      // in other scopes - always return "not found" rather than "forbidden"
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Compose not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "another-scope/secret-agent",
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should NOT show "forbidden" or "unauthorized" - just "not found"
      const allErrors = mockConsoleError.mock.calls.map(
        (call) => call[0] as string,
      );
      const hasForbidden = allErrors.some(
        (err) =>
          err.toLowerCase().includes("forbidden") ||
          err.toLowerCase().includes("unauthorized") ||
          err.toLowerCase().includes("permission denied"),
      );
      expect(hasForbidden).toBe(false);

      // Should show "not found" behavior
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
    });
  });
});
