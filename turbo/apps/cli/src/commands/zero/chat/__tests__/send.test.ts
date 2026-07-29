import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroChatCommand } from "../index";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000010";
const RUN_ID = "00000000-0000-4000-8000-000000000020";
const SEND_URL = "http://localhost:3000/api/zero/chat/events";

function metadataUrl(threadId: string): string {
  return `http://localhost:3000/api/zero/chat-threads/${threadId}/metadata`;
}

describe("zero chat send command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
    vi.stubEnv("ZERO_CHAT_THREAD_ID", THREAD_ID);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it("constructs a text UserMessageDocument and dispatches an idle thread", async () => {
    let sentEventId: string | undefined;
    server.use(
      http.get(metadataUrl(THREAD_ID), () => {
        return HttpResponse.json({
          id: THREAD_ID,
          agentId: AGENT_ID,
          title: "Launch plan",
          selectedModel: null,
        });
      }),
      http.post(SEND_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-zero-token",
        );
        const body = (await request.json()) as Record<string, unknown>;
        sentEventId = String(body.clientEventId);
        expect(body).toMatchObject({
          agentId: AGENT_ID,
          threadId: THREAD_ID,
          prompt: "Continue the analysis",
          hasTextContent: true,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Continue the analysis" }],
          },
        });
        expect(body.clientEventId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(body.chatThreadSortEventId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        return HttpResponse.json(
          {
            runId: RUN_ID,
            threadId: THREAD_ID,
            status: "pending",
            createdAt: "2026-07-29T10:00:00.000Z",
          },
          { status: 201 },
        );
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "send",
      "--text",
      "  Continue the analysis  ",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        threadId: THREAD_ID,
        eventId: sentEventId,
        runId: RUN_ID,
        status: "pending",
        createdAt: "2026-07-29T10:00:00.000Z",
        messageQueued: false,
      },
    );
  });

  it("reports a message that remains queued and honors --thread-id", async () => {
    vi.stubEnv("ZERO_CHAT_THREAD_ID", undefined);
    server.use(
      http.get(metadataUrl(OTHER_THREAD_ID), () => {
        return HttpResponse.json({
          id: OTHER_THREAD_ID,
          title: "Busy thread",
          selectedModel: null,
        });
      }),
      http.get("http://localhost:3000/api/zero/chat-threads/snapshot", () => {
        return HttpResponse.json({
          chatThreads: [
            {
              id: OTHER_THREAD_ID,
              agentId: AGENT_ID,
              title: "Busy thread",
              sortAt: "2026-07-29T10:00:00.000Z",
              createdAt: "2026-07-29T10:00:00.000Z",
              updatedAt: "2026-07-29T10:00:00.000Z",
              pinnedAt: null,
              renamedAt: null,
              selectedModel: null,
              serviceTier: null,
              computerUseHostId: null,
            },
          ],
          latestEventId: null,
          latestSeqId: null,
        });
      }),
      http.post(SEND_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.threadId).toBe(OTHER_THREAD_ID);
        return HttpResponse.json(
          {
            runId: null,
            threadId: OTHER_THREAD_ID,
            createdAt: "2026-07-29T10:00:00.000Z",
          },
          { status: 201 },
        );
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "send",
      "--thread-id",
      OTHER_THREAD_ID,
      "--text",
      "Wait your turn",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Chat message queued");
    expect(output).toContain(`Thread: ${OTHER_THREAD_ID}`);
    expect(output).toContain("Event:");
    expect(output).not.toContain("Run:");
  });

  it("rejects whitespace-only message text before calling the API", async () => {
    await expect(async () => {
      await zeroChatCommand.parseAsync([
        "node",
        "cli",
        "send",
        "--text",
        "   ",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Chat message text is required");
    expect(stderr).toContain('Pass --text "message"');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
