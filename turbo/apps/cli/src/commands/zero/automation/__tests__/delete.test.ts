/**
 * Tests for `zero automation delete` (unified automations).
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { deleteCommand } from "../delete";
import chalk from "chalk";

describe("zero automation delete command", () => {
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

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("should delete an automation by name with --yes", async () => {
    let deletedRef: string | undefined;

    server.use(
      http.delete(
        "http://localhost:3000/api/automations/:ref",
        ({ params }) => {
          deletedRef = params.ref as string;
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    await deleteCommand.parseAsync(["node", "cli", "alerts", "-y"]);

    expect(deletedRef).toBe("alerts");
    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain('Automation "alerts" deleted');
  });

  it("should require --yes in non-interactive mode", async () => {
    await expect(async () => {
      await deleteCommand.parseAsync(["node", "cli", "alerts"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("--yes flag is required"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should surface not-found errors", async () => {
    server.use(
      http.delete("http://localhost:3000/api/automations/:ref", () => {
        return HttpResponse.json(
          { error: { message: "Automation not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
    );

    await expect(async () => {
      await deleteCommand.parseAsync(["node", "cli", "missing", "-y"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Automation not found"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
