/**
 * Tests for zero slack message send command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { sendCommand } from "../message/send";
import chalk from "chalk";

const SLACK_MESSAGE_URL =
  "http://localhost:3000/api/zero/integrations/slack/message";

describe("zero slack message send command", () => {
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
  });

  describe("successful send", () => {
    it("should send a message with --text", async () => {
      server.use(
        http.post(SLACK_MESSAGE_URL, () => {
          return HttpResponse.json(
            { ok: true, ts: "1234567890.123456", channel: "C1234567" },
            { status: 200 },
          );
        }),
      );

      await sendCommand.parseAsync([
        "node",
        "cli",
        "--channel",
        "C1234567",
        "--text",
        "hello world",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Message sent");
      expect(logCalls).toContain("ts: 1234567890.123456");
    });

    it("should send a DM with --user flag", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(SLACK_MESSAGE_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { ok: true, ts: "1234567890.123456", channel: "D-dm-channel" },
            { status: 200 },
          );
        }),
      );

      await sendCommand.parseAsync([
        "node",
        "cli",
        "--user",
        "U0A8V9X98QJ",
        "--text",
        "Hello DM!",
      ]);

      expect(capturedBody).toMatchObject({
        user: "U0A8V9X98QJ",
        text: "Hello DM!",
      });
      expect(capturedBody).not.toHaveProperty("channel");

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Message sent");
    });

    it("should send a message with --text and --thread", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(SLACK_MESSAGE_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { ok: true, ts: "1234567890.123456", channel: "C1234567" },
            { status: 200 },
          );
        }),
      );

      await sendCommand.parseAsync([
        "node",
        "cli",
        "--channel",
        "C1234567",
        "--text",
        "thread reply",
        "--thread",
        "1234567890.000000",
      ]);

      expect(capturedBody).toMatchObject({
        channel: "C1234567",
        text: "thread reply",
        threadTs: "1234567890.000000",
      });
    });

    it("should send a message with --blocks", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(SLACK_MESSAGE_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { ok: true, ts: "1234567890.123456", channel: "C1234567" },
            { status: 200 },
          );
        }),
      );

      const blocks = JSON.stringify([
        { type: "section", text: { type: "mrkdwn", text: "hello" } },
      ]);

      await sendCommand.parseAsync([
        "node",
        "cli",
        "--channel",
        "C1234567",
        "--blocks",
        blocks,
      ]);

      expect(capturedBody).toMatchObject({
        channel: "C1234567",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "hello" } }],
      });
    });
  });

  describe("validation errors", () => {
    it("should error when both --channel and --user are provided", async () => {
      await expect(async () => {
        await sendCommand.parseAsync([
          "node",
          "cli",
          "--channel",
          "C1234567",
          "--user",
          "U0A8V9X98QJ",
          "--text",
          "hello",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--channel and --user are mutually exclusive"),
      );
    });

    it("should error when neither --channel nor --user is provided", async () => {
      await expect(async () => {
        await sendCommand.parseAsync(["node", "cli", "--text", "hello"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Either --channel or --user must be provided"),
      );
    });

    it("should error when neither --text nor --blocks is provided", async () => {
      await expect(async () => {
        await sendCommand.parseAsync(["node", "cli", "--channel", "C1234567"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Either --text or --blocks must be provided"),
      );
    });

    it("should error when --blocks contains invalid JSON", async () => {
      await expect(async () => {
        await sendCommand.parseAsync([
          "node",
          "cli",
          "--channel",
          "C1234567",
          "--blocks",
          "not-json",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid JSON for --blocks flag"),
      );
    });
  });

  describe("API errors", () => {
    it("should handle 401 unauthorized", async () => {
      server.use(
        http.post(SLACK_MESSAGE_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await sendCommand.parseAsync([
          "node",
          "cli",
          "--channel",
          "C1234567",
          "--text",
          "hello",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
    });

    it("should handle 404 no Slack installation", async () => {
      server.use(
        http.post(SLACK_MESSAGE_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "No Slack installation found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await sendCommand.parseAsync([
          "node",
          "cli",
          "--channel",
          "C1234567",
          "--text",
          "hello",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No Slack installation found"),
      );
    });
  });
});
