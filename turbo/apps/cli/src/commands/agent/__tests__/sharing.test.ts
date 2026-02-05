/**
 * Tests for agent sharing commands (public, private, share, unshare, permission)
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { publicCommand } from "../public";
import { privateCommand } from "../private";
import { shareCommand } from "../share";
import { unshareCommand } from "../unshare";
import { permissionCommand } from "../permission";
import chalk from "chalk";

describe("Agent Sharing Commands", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  const testComposeId = "test-compose-123";
  const testAgentName = "my-agent";
  const testScopeSlug = "test-user";

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    // Default handler to resolve agent name to compose ID
    server.use(
      http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
        const url = new URL(request.url);
        const name = url.searchParams.get("name");
        if (name === testAgentName) {
          return HttpResponse.json({
            id: testComposeId,
            name: testAgentName,
          });
        }
        return HttpResponse.json(
          { error: { message: "Agent compose not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
      // Default handler for scope API
      http.get("http://localhost:3000/api/scope", () => {
        return HttpResponse.json({
          id: "scope-123",
          slug: testScopeSlug,
          type: "personal",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("vm0 agent experimental-public", () => {
    it("should make agent public successfully", async () => {
      server.use(
        http.post(
          `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
          async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            expect(body.granteeType).toBe("public");
            return HttpResponse.json({
              permission: {
                id: "perm-123",
                granteeType: "public",
                grantedBy: "user-123",
              },
            });
          },
        ),
      );

      await publicCommand.parseAsync(["node", "cli", testAgentName]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("now public"),
      );
      // Check for run command hint with experimental flag
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining(
          `vm0 run ${testScopeSlug}/${testAgentName} --experimental-shared-agent`,
        ),
      );
    });

    it("should handle already public agent", async () => {
      server.use(
        http.post(
          `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Permission already exists",
                  code: "CONFLICT",
                },
              },
              { status: 409 },
            );
          },
        ),
      );

      await publicCommand.parseAsync(["node", "cli", testAgentName]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("already public"),
      );
    });

    it("should handle agent not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            {
              error: { message: "Agent compose not found", code: "NOT_FOUND" },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await publicCommand.parseAsync(["node", "cli", "nonexistent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Agent not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("vm0 agent experimental-private", () => {
    it("should make agent private successfully", async () => {
      server.use(
        http.delete(
          `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("type")).toBe("public");
            return HttpResponse.json({ message: "Permission removed" });
          },
        ),
      );

      await privateCommand.parseAsync(["node", "cli", testAgentName]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("now private"),
      );
    });

    it("should handle already private agent", async () => {
      server.use(
        http.delete(
          `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
          () => {
            return HttpResponse.json(
              { error: { message: "Permission not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
      );

      await privateCommand.parseAsync(["node", "cli", testAgentName]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("already private"),
      );
    });
  });

  describe("vm0 agent experimental-share", () => {
    it("should share agent with email successfully", async () => {
      const shareEmail = "user@example.com";

      server.use(
        http.post(
          `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
          async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            expect(body.granteeType).toBe("email");
            expect(body.granteeEmail).toBe(shareEmail);
            return HttpResponse.json({
              permission: {
                id: "perm-456",
                granteeType: "email",
                granteeEmail: shareEmail,
              },
            });
          },
        ),
      );

      await shareCommand.parseAsync([
        "node",
        "cli",
        testAgentName,
        "--email",
        shareEmail,
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("shared with"),
      );
      // Check for run command hint with experimental flag
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining(
          `vm0 run ${testScopeSlug}/${testAgentName} --experimental-shared-agent`,
        ),
      );
    });

    it("should handle already shared with same email", async () => {
      server.use(
        http.post(
          `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Permission already exists",
                  code: "CONFLICT",
                },
              },
              { status: 409 },
            );
          },
        ),
      );

      await shareCommand.parseAsync([
        "node",
        "cli",
        testAgentName,
        "--email",
        "user@example.com",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("already shared"),
      );
    });
  });

  describe("vm0 agent experimental-unshare", () => {
    it("should unshare agent from email successfully", async () => {
      const unshareEmail = "user@example.com";

      server.use(
        http.delete(
          `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("type")).toBe("email");
            expect(url.searchParams.get("email")).toBe(unshareEmail);
            return HttpResponse.json({ message: "Permission removed" });
          },
        ),
      );

      await unshareCommand.parseAsync([
        "node",
        "cli",
        testAgentName,
        "--email",
        unshareEmail,
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Removed sharing"),
      );
    });

    it("should handle not shared with email", async () => {
      server.use(
        http.delete(
          `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
          () => {
            return HttpResponse.json(
              { error: { message: "Permission not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
      );

      await unshareCommand.parseAsync([
        "node",
        "cli",
        testAgentName,
        "--email",
        "user@example.com",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("not shared"),
      );
    });
  });

  describe("vm0 agent experimental-permission", () => {
    it("should list permissions for agent", async () => {
      server.use(
        http.get(
          `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
          () => {
            return HttpResponse.json({
              permissions: [
                {
                  id: "perm-1",
                  granteeType: "public",
                  granteeEmail: null,
                  permission: "run_view",
                  grantedBy: "user-123",
                  createdAt: new Date().toISOString(),
                },
                {
                  id: "perm-2",
                  granteeType: "email",
                  granteeEmail: "user@example.com",
                  permission: "run_view",
                  grantedBy: "user-123",
                  createdAt: new Date().toISOString(),
                },
              ],
            });
          },
        ),
      );

      await permissionCommand.parseAsync(["node", "cli", testAgentName]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("public");
      expect(logCalls).toContain("user@example.com");
    });

    it("should show message when no permissions", async () => {
      server.use(
        http.get(
          `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
          () => {
            return HttpResponse.json({ permissions: [] });
          },
        ),
      );

      await permissionCommand.parseAsync(["node", "cli", testAgentName]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("No permissions"),
      );
    });

    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await permissionCommand.parseAsync(["node", "cli", testAgentName]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to list permissions"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
