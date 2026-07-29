import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroChatCommand } from "../index";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const REVOKED_EVENT_ID = "00000000-0000-4000-8000-000000000011";
const REVOKE_EVENT_ID = "00000000-0000-4000-8000-000000000012";
const QUEUED_EVENT_ID = "00000000-0000-4000-8000-000000000013";
const AUTOMATION_EVENT_ID = "00000000-0000-4000-8000-000000000014";
const AUTOMATION_ID = "00000000-0000-4000-8000-000000000015";
const EVENTS_URL = `http://localhost:3000/api/zero/chat-threads/${THREAD_ID}/events`;

function promptEvent(args: {
  id: string;
  seqId: number;
  text: string;
  createdAt: string;
}) {
  return {
    id: args.id,
    threadId: THREAD_ID,
    eventType: "input.prompt" as const,
    content: args.text,
    userMessage: {
      version: 1 as const,
      parts: [{ type: "text" as const, text: args.text }],
    },
    seqId: args.seqId,
    createdAt: args.createdAt,
  };
}

describe("zero chat queued command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
    vi.stubEnv("ZERO_CHAT_THREAD_ID", THREAD_ID);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("paginates the history and folds revoked queue events", async () => {
    const cursors: Array<string | null> = [];
    server.use(
      http.get(EVENTS_URL, ({ request }) => {
        const url = new URL(request.url);
        const beforeSeqId = url.searchParams.get("beforeSeqId");
        cursors.push(beforeSeqId);
        expect(url.searchParams.get("limit")).toBe("50");

        if (beforeSeqId === null) {
          return HttpResponse.json({
            events: [
              {
                id: REVOKE_EVENT_ID,
                threadId: THREAD_ID,
                eventType: "control.revoke",
                content: null,
                revokesEventId: REVOKED_EVENT_ID,
                seqId: 2,
                createdAt: "2026-07-29T10:01:00.000Z",
              },
              promptEvent({
                id: QUEUED_EVENT_ID,
                seqId: 3,
                text: "  Keep   this queued  ",
                createdAt: "2026-07-29T10:02:00.000Z",
              }),
              {
                id: AUTOMATION_EVENT_ID,
                threadId: THREAD_ID,
                eventType: "input.automation",
                content: null,
                automationId: AUTOMATION_ID,
                triggerSource: "workflow-event",
                triggerBrief: "  Gmail   label applied ",
                seqId: 4,
                createdAt: "2026-07-29T10:03:00.000Z",
              },
            ],
            hasHistoryBefore: true,
          });
        }

        expect(beforeSeqId).toBe("2");
        return HttpResponse.json({
          events: [
            promptEvent({
              id: REVOKED_EVENT_ID,
              seqId: 1,
              text: "Remove this",
              createdAt: "2026-07-29T10:00:00.000Z",
            }),
          ],
          hasHistoryBefore: false,
        });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "queued", "--json"]);

    expect(cursors).toStrictEqual([null, "2"]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        threadId: THREAD_ID,
        total: 2,
        queued: [
          {
            eventId: QUEUED_EVENT_ID,
            eventType: "input.prompt",
            createdAt: "2026-07-29T10:02:00.000Z",
            text: "Keep this queued",
          },
          {
            eventId: AUTOMATION_EVENT_ID,
            eventType: "input.automation",
            createdAt: "2026-07-29T10:03:00.000Z",
            text: "Gmail label applied",
          },
        ],
      },
    );
  });

  it("prints an empty queue message", async () => {
    server.use(
      http.get(EVENTS_URL, () => {
        return HttpResponse.json({
          events: [],
          hasHistoryBefore: false,
        });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "queued"]);

    expect(mockConsoleLog).toHaveBeenCalledWith("No queued chat events");
  });
});
