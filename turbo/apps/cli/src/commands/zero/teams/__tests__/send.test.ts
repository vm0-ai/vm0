/**
 * Tests for zero teams message send command.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../mocks/server";
import { sendCommand } from "../message/send";

const TEAMS_MESSAGE_URL =
  "http://localhost:3000/api/zero/integrations/teams/message";

describe("zero teams message send command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-token");
  });

  it("sends a message with conversation and activity IDs", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    server.use(
      http.post(TEAMS_MESSAGE_URL, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ok: true,
          activityId: "teams-activity-1",
          conversationId: "19:thread@thread.tacv2",
        });
      }),
    );

    await sendCommand.parseAsync([
      "node",
      "cli",
      "--conversation-id",
      "19:thread@thread.tacv2",
      "--activity-id",
      "root-activity",
      "--text",
      "hello Teams",
    ]);

    expect(capturedBody).toStrictEqual({
      conversationId: "19:thread@thread.tacv2",
      activityId: "root-activity",
      text: "hello Teams",
    });
    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Message sent");
    expect(logCalls).toContain("activity_id: teams-activity-1");
  });

  it("sends a DM with an Adaptive Card", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    server.use(
      http.post(TEAMS_MESSAGE_URL, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ok: true,
          activityId: "teams-dm-activity-1",
          conversationId: "a:teams-dm-conversation",
        });
      }),
    );

    await sendCommand.parseAsync([
      "node",
      "cli",
      "--user",
      "me",
      "--text",
      "Pick a workflow",
      "--card",
      '{"type":"AdaptiveCard","version":"1.4","body":[{"type":"TextBlock","text":"Pick a workflow","wrap":true}]}',
    ]);

    expect(capturedBody).toStrictEqual({
      user: "me",
      text: "Pick a workflow",
      card: {
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          {
            type: "TextBlock",
            text: "Pick a workflow",
            wrap: true,
          },
        ],
      },
    });
    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Message sent");
    expect(logCalls).toContain("activity_id: teams-dm-activity-1");
  });

  it("errors when message text is missing", async () => {
    await expect(async () => {
      await sendCommand.parseAsync([
        "node",
        "cli",
        "--conversation-id",
        "19:thread@thread.tacv2",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "Either --text, --card, or piped stdin must be provided",
      ),
    );
  });

  it("errors when a target is missing", async () => {
    await expect(async () => {
      await sendCommand.parseAsync(["node", "cli", "--text", "hello"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "Either --conversation-id or --user must be provided",
      ),
    );
  });
});
