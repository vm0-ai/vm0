/**
 * Tests for zero telegram bot list command.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { listCommand } from "../bot/list";
import chalk from "chalk";

const TELEGRAM_BOTS_URL =
  "http://localhost:3000/api/zero/integrations/telegram/bots";

describe("zero telegram bot list command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
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
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("displays Telegram bots in table format", async () => {
    server.use(
      http.get(TELEGRAM_BOTS_URL, () => {
        return HttpResponse.json({
          bots: [
            {
              id: "123456789",
              username: "alerts_bot",
              agent: { id: "agent-1", name: "alerts" },
              isOwner: true,
              isConnected: true,
              tokenStatus: "valid",
            },
          ],
        });
      }),
    );

    await listCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("123456789");
    expect(logCalls).toContain("@alerts_bot");
    expect(logCalls).toContain("alerts");
    expect(logCalls).toContain("yes");
    expect(logCalls).toContain("valid");
  });

  it("displays empty state when no bots are available", async () => {
    server.use(
      http.get(TELEGRAM_BOTS_URL, () => {
        return HttpResponse.json({ bots: [] });
      }),
    );

    await listCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("No Telegram bots found");
  });

  it("surfaces API errors", async () => {
    server.use(
      http.get(TELEGRAM_BOTS_URL, () => {
        return HttpResponse.json(
          { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    await expect(async () => {
      await listCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Not authenticated"),
    );
  });
});
