/**
 * Tests for org create command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW, config file I/O
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { createCommand } from "../create";
import chalk from "chalk";

vi.mock("../../../../lib/api/config", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../../lib/api/config")>();
  return {
    ...original,
    setOrgToken: vi.fn().mockResolvedValue(undefined),
    clearOrgToken: vi.fn().mockResolvedValue(undefined),
    loadConfig: vi.fn().mockResolvedValue({ activeScope: undefined }),
  };
});

describe("org create command", () => {
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

  it("should create org and auto-switch scope, show success", async () => {
    server.use(
      http.post("http://localhost:3000/api/org", () => {
        return HttpResponse.json(
          {
            slug: "my-team",
            role: "admin",
            members: [
              {
                userId: "user-1",
                email: "",
                role: "admin",
                joinedAt: "2025-01-01T00:00:00Z",
              },
            ],
            createdAt: "2025-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      }),
      http.post("http://localhost:3000/api/scope/use", () => {
        return HttpResponse.json({
          scope: {
            id: "scope-1",
            slug: "my-team",
            type: "organization",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
          token: "vm0_org_test-token",
          expiresAt: "2025-01-01T02:00:00Z",
        });
      }),
    );

    await createCommand.parseAsync(["node", "cli", "my-team"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("my-team");
    expect(logCalls).toContain("created");
  });

  it("should handle 'already own an organization' error", async () => {
    server.use(
      http.post("http://localhost:3000/api/org", () => {
        return HttpResponse.json(
          {
            error: {
              message: "You already own an organization",
              code: "BAD_REQUEST",
            },
          },
          { status: 400 },
        );
      }),
    );

    await expect(async () => {
      await createCommand.parseAsync(["node", "cli", "new-org"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("already own an organization"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
