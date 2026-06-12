/**
 * Tests for `zero automation run` (v2 unified automations).
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { runCommand } from "../run";
import chalk from "chalk";

describe("zero automation run command", () => {
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

  it("should fire an automation manually and print the run id", async () => {
    let firedRef: string | undefined;

    server.use(
      http.post(
        "http://localhost:3000/api/automations/:ref/run",
        ({ params }) => {
          firedRef = params.ref as string;
          return HttpResponse.json({ runId: "run-123" }, { status: 201 });
        },
      ),
    );

    await runCommand.parseAsync(["node", "cli", "alerts"]);

    expect(firedRef).toBe("alerts");
    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain('Automation "alerts" fired');
    expect(logCalls).toContain("run-123");
  });

  it("should surface API errors (e.g. insufficient credits)", async () => {
    server.use(
      http.post("http://localhost:3000/api/automations/:ref/run", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Insufficient credits",
              code: "INSUFFICIENT_CREDITS",
            },
          },
          { status: 402 },
        );
      }),
    );

    await expect(async () => {
      await runCommand.parseAsync(["node", "cli", "alerts"]);
    }).rejects.toThrow("process.exit called");

    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
