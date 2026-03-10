/**
 * Tests for scope use command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW, os.homedir for config isolation
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { useCommand } from "../use";
import { mkdtempSync } from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

// Mock os.homedir to use temp directory
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-scope-use-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return { ...original, homedir: () => TEST_HOME };
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
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  it("should switch to org scope and show success", async () => {
    server.use(
      http.get("http://localhost:3000/api/scope/list", () => {
        return HttpResponse.json({
          scopes: [{ slug: "my-org", role: "admin" }],
          active: undefined,
        });
      }),
    );

    await useCommand.parseAsync(["node", "cli", "my-org"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("my-org");
  });

  it("should switch to personal scope with --personal flag", async () => {
    await useCommand.parseAsync(["node", "cli", "--personal"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("default scope");
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

  it("should handle scope not found", async () => {
    server.use(
      http.get("http://localhost:3000/api/scope/list", () => {
        return HttpResponse.json({
          scopes: [],
          active: undefined,
        });
      }),
    );

    await expect(async () => {
      await useCommand.parseAsync(["node", "cli", "nonexistent"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should handle API error", async () => {
    server.use(
      http.get("http://localhost:3000/api/scope/list", () => {
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
      await useCommand.parseAsync(["node", "cli", "nonexistent"]);
    }).rejects.toThrow("process.exit called");

    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
