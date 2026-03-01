/**
 * Tests for scope use command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW, config file I/O
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { useCommand } from "../use";
import chalk from "chalk";

vi.mock("../../../lib/api/config", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../lib/api/config")>();
  return {
    ...original,
    setOrgToken: vi.fn().mockResolvedValue(undefined),
    clearOrgToken: vi.fn().mockResolvedValue(undefined),
    loadConfig: vi.fn().mockResolvedValue({ activeScope: undefined }),
  };
});

describe("scope use command", () => {
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

  it("should switch to org scope and show success", async () => {
    server.use(
      http.post("http://localhost:3000/api/scope/use", () => {
        return HttpResponse.json({
          scope: {
            id: "scope-1",
            slug: "my-org",
            type: "organization",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
          token: "vm0_org_test-token",
          expiresAt: "2025-01-01T02:00:00Z",
        });
      }),
    );

    await useCommand.parseAsync(["node", "cli", "my-org"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("my-org");
    expect(logCalls).toContain("organization");
  });

  it("should switch to personal scope with --personal flag", async () => {
    await useCommand.parseAsync(["node", "cli", "--personal"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("personal scope");
  });

  it("should require slug argument without --personal", async () => {
    await expect(async () => {
      await useCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Scope slug is required"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show system label for system scope", async () => {
    server.use(
      http.post("http://localhost:3000/api/scope/use", () => {
        return HttpResponse.json({
          scope: {
            id: "scope-sys",
            slug: "vm0",
            type: "system",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
          token: "vm0_org_admin-token",
          expiresAt: "2025-01-01T02:00:00Z",
        });
      }),
    );

    await useCommand.parseAsync(["node", "cli", "vm0"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("vm0");
    expect(logCalls).toContain("system");
    expect(logCalls).not.toContain("organization");
  });

  it("should handle API error", async () => {
    server.use(
      http.post("http://localhost:3000/api/scope/use", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Scope not found",
              code: "NOT_FOUND",
            },
          },
          { status: 404 },
        );
      }),
    );

    await expect(async () => {
      await useCommand.parseAsync(["node", "cli", "nonexistent"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Scope not found"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
