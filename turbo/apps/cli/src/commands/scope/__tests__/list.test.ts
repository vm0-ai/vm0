/**
 * Tests for scope list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW, config file I/O
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

vi.mock("../../../lib/api/config", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../lib/api/config")>();
  return {
    ...original,
    loadConfig: vi.fn().mockResolvedValue({ activeScope: "my-org" }),
  };
});

describe("scope list command", () => {
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

  it("should display scopes with roles", async () => {
    server.use(
      http.get("http://localhost:3000/api/scope/list", () => {
        return HttpResponse.json({
          scopes: [
            { slug: "personal-user", role: "admin" },
            { slug: "my-org", role: "admin" },
          ],
          active: undefined,
        });
      }),
    );

    await listCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("personal-user");
    expect(logCalls).toContain("admin");
    expect(logCalls).toContain("my-org");
    expect(logCalls).toContain("admin");
  });

  it("should mark current scope", async () => {
    server.use(
      http.get("http://localhost:3000/api/scope/list", () => {
        return HttpResponse.json({
          scopes: [
            { slug: "personal-user", role: "admin" },
            { slug: "my-org", role: "admin" },
          ],
          active: undefined,
        });
      }),
    );

    await listCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("current");
  });

  it("should handle API error", async () => {
    server.use(
      http.get("http://localhost:3000/api/scope/list", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Internal server error",
              code: "SERVER_ERROR",
            },
          },
          { status: 500 },
        );
      }),
    );

    await expect(async () => {
      await listCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Internal server error"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
