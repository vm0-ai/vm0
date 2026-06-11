/**
 * Tests for `zero automation enable` (v2 unified automations).
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { enableCommand } from "../enable";
import chalk from "chalk";

const mockAutomation = {
  id: "11111111-1111-4111-8111-111111111111",
  agentId: "550e8400-e29b-41d4-a716-446655440000",
  displayName: "my-agent",
  userId: "user-001",
  name: "alerts",
  description: null,
  instruction: "Summarize alerts",
  appendSystemPrompt: null,
  enabled: true,
  chatThreadId: "550e8400-e29b-41d4-a716-446655440099",
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
  triggers: [],
};

describe("zero automation enable command", () => {
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

  it("should enable an automation by ref", async () => {
    let enabledRef: string | undefined;

    server.use(
      http.post(
        "http://localhost:3000/api/v2/automations/:ref/enable",
        ({ params }) => {
          enabledRef = params.ref as string;
          return HttpResponse.json(mockAutomation);
        },
      ),
    );

    await enableCommand.parseAsync(["node", "cli", "alerts"]);

    expect(enabledRef).toBe("alerts");
    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain('Automation "alerts" enabled');
  });

  it("should surface API errors", async () => {
    server.use(
      http.post("http://localhost:3000/api/v2/automations/:ref/enable", () => {
        return HttpResponse.json(
          { error: { message: "Automation not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
    );

    await expect(async () => {
      await enableCommand.parseAsync(["node", "cli", "missing"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Automation not found"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
