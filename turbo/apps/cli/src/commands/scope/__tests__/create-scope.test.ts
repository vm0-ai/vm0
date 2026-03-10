/**
 * Tests for scope create command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW, os.homedir for config isolation
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createCommand } from "../create-scope";
import { mkdtempSync } from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

// Mock os.homedir to use temp directory
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-scope-create-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return { ...original, homedir: () => TEST_HOME };
});

describe("scope create command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  it("should show friendly error when user already has a scope", async () => {
    server.use(
      http.get("http://localhost:3000/api/scope", () => {
        return HttpResponse.json({
          id: "test-id",
          slug: "user-a1b2c3d4",
          tier: "free",
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
        });
      }),
    );

    await expect(async () => {
      await createCommand.parseAsync(["node", "cli", "my-team"]);
    }).rejects.toThrow("process.exit called");

    const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorCalls).toContain("already have a scope: user-a1b2c3d4");
    expect(errorCalls).toContain("vm0 scope set my-team --force");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should create scope and auto-activate when user has none", async () => {
    server.use(
      http.get("http://localhost:3000/api/scope", () => {
        return HttpResponse.json(
          { error: { message: "No scope configured", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
      http.post("http://localhost:3000/api/scope", () => {
        return HttpResponse.json(
          {
            id: "new-id",
            slug: "my-team",
            tier: "free",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      }),
    );

    await createCommand.parseAsync(["node", "cli", "my-team"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("my-team");
    expect(logCalls).toContain("created and activated");
  });

  it("should propagate non-scope errors from pre-check", async () => {
    server.use(
      http.get("http://localhost:3000/api/scope", () => {
        return HttpResponse.json(
          { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    await expect(async () => {
      await createCommand.parseAsync(["node", "cli", "my-team"]);
    }).rejects.toThrow("Not authenticated");
  });
});
