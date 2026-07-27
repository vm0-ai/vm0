import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroChatCommand } from "../index";

const AGENT_ID = "00000000-0000-4000-8000-000000000101";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000102";
const THREAD_ID = "00000000-0000-4000-8000-000000000201";
const SECOND_THREAD_ID = "00000000-0000-4000-8000-000000000202";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000203";
const INITIAL_EVENT_ID = "00000000-0000-4000-8000-000000000301";
const RENAME_EVENT_ID = "00000000-0000-4000-8000-000000000302";
const SORT_EVENT_ID = "00000000-0000-4000-8000-000000000303";
const REFRESH_EVENT_ID = "00000000-0000-4000-8000-000000000304";
const INITIAL_SEQ_ID = 1;
const RENAME_SEQ_ID = 2;
const SORT_SEQ_ID = 3;
const REFRESH_SEQ_ID = 4;
const SNAPSHOT_URL = "http://localhost:3000/api/zero/chat-threads/snapshot";
const EVENTS_URL = "http://localhost:3000/api/zero/chat-threads/events";

function zeroToken(): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId: "user_test",
      runId: "00000000-0000-4000-8000-000000000401",
      orgId: "org_test",
      scope: "zero",
      capabilities: ["chat-thread:read"],
      iat: 1,
      exp: 4_102_444_800,
    }),
  ).toString("base64url");
  return `vm0_sandbox_e30.${payload}.signature`;
}

function snapshotThread(options: {
  readonly id: string;
  readonly agentId: string;
  readonly title: string;
  readonly sortAt: string;
}) {
  return {
    ...options,
    createdAt: options.sortAt,
    updatedAt: options.sortAt,
    pinnedAt: null,
    renamedAt: null,
    selectedModel: null,
  };
}

function event(options: {
  readonly id: string;
  readonly seqId: number;
  readonly kind: "renamed" | "sort_touched";
  readonly chatThreadId: string;
  readonly agentId: string;
  readonly title: string | null;
  readonly createdAt: string;
}) {
  return {
    ...options,
    selectedModel: null,
  };
}

describe("zero chat list command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  let cacheDirectory: string;

  beforeEach(async () => {
    chalk.level = 0;
    cacheDirectory = await mkdtemp(join(tmpdir(), "zero-chat-list-"));
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", zeroToken());
    vi.stubEnv("ZERO_AGENT_ID", AGENT_ID);
    vi.stubEnv("XDG_CACHE_HOME", cacheDirectory);
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
    await rm(cacheDirectory, { recursive: true, force: true });
  });

  it("replays incremental events from the cache and defaults to ZERO_AGENT_ID", async () => {
    let snapshotRequests = 0;
    let eventRequests = 0;
    server.use(
      http.get(SNAPSHOT_URL, () => {
        snapshotRequests++;
        return HttpResponse.json({
          chatThreads: [
            snapshotThread({
              id: THREAD_ID,
              agentId: AGENT_ID,
              title: "Initial title",
              sortAt: "2026-07-24T03:00:00.000Z",
            }),
            snapshotThread({
              id: SECOND_THREAD_ID,
              agentId: AGENT_ID,
              title: "Second title",
              sortAt: "2026-07-24T02:00:00.000Z",
            }),
            snapshotThread({
              id: OTHER_THREAD_ID,
              agentId: OTHER_AGENT_ID,
              title: "Other agent",
              sortAt: "2026-07-24T04:00:00.000Z",
            }),
          ],
          latestEventId: INITIAL_EVENT_ID,
          latestSeqId: INITIAL_SEQ_ID,
        });
      }),
      http.get(EVENTS_URL, ({ request }) => {
        eventRequests++;
        const cursor = new URL(request.url).searchParams.get("sinceSeqId");
        if (eventRequests === 1) {
          expect(cursor).toBe(String(INITIAL_SEQ_ID));
          return HttpResponse.json({
            events: [
              event({
                id: RENAME_EVENT_ID,
                seqId: RENAME_SEQ_ID,
                kind: "renamed",
                chatThreadId: THREAD_ID,
                agentId: AGENT_ID,
                title: "Renamed title",
                createdAt: "2026-07-24T03:30:00.000Z",
              }),
            ],
            hasMore: false,
          });
        }

        expect(cursor).toBe(String(RENAME_SEQ_ID));
        return HttpResponse.json({
          events: [
            event({
              id: SORT_EVENT_ID,
              seqId: SORT_SEQ_ID,
              kind: "sort_touched",
              chatThreadId: SECOND_THREAD_ID,
              agentId: AGENT_ID,
              title: null,
              createdAt: "2026-07-24T05:00:00.000Z",
            }),
          ],
          hasMore: false,
        });
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "list",
      "--limit",
      "1",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        agentId: AGENT_ID,
        total: 2,
        threads: [
          expect.objectContaining({
            id: THREAD_ID,
            agentId: AGENT_ID,
            title: "Renamed title",
          }),
        ],
      },
    );

    mockConsoleLog.mockClear();
    await zeroChatCommand.parseAsync(["node", "cli", "list", "--json"]);

    const secondOutput = JSON.parse(
      String(mockConsoleLog.mock.calls[0]?.[0]),
    ) as {
      readonly threads: readonly { readonly id: string }[];
    };
    expect(
      secondOutput.threads.map((thread) => {
        return thread.id;
      }),
    ).toStrictEqual([SECOND_THREAD_ID, THREAD_ID]);
    expect(snapshotRequests).toBe(1);
    expect(eventRequests).toBe(2);
  });

  it("reloads the snapshot when the cached event cursor expires", async () => {
    let snapshotRequests = 0;
    let eventRequests = 0;
    server.use(
      http.get(SNAPSHOT_URL, () => {
        snapshotRequests++;
        return HttpResponse.json({
          chatThreads: [
            snapshotThread({
              id: THREAD_ID,
              agentId: AGENT_ID,
              title:
                snapshotRequests === 1 ? "Cached title" : "Refreshed title",
              sortAt: "2026-07-24T03:00:00.000Z",
            }),
          ],
          latestEventId:
            snapshotRequests === 1 ? INITIAL_EVENT_ID : REFRESH_EVENT_ID,
          latestSeqId: snapshotRequests === 1 ? INITIAL_SEQ_ID : REFRESH_SEQ_ID,
        });
      }),
      http.get(EVENTS_URL, ({ request }) => {
        eventRequests++;
        const cursor = new URL(request.url).searchParams.get("sinceSeqId");
        if (eventRequests === 2) {
          expect(cursor).toBe(String(INITIAL_SEQ_ID));
          return HttpResponse.json(
            {
              error: {
                message: "Chat thread events cursor has expired",
                code: "CHAT_THREAD_EVENTS_EXPIRED",
              },
            },
            { status: 410 },
          );
        }
        expect(cursor).toBe(
          String(eventRequests === 1 ? INITIAL_SEQ_ID : REFRESH_SEQ_ID),
        );
        return HttpResponse.json({ events: [], hasMore: false });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "list", "--json"]);
    mockConsoleLog.mockClear();
    await zeroChatCommand.parseAsync(["node", "cli", "list", "--json"]);

    const output = JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0])) as {
      readonly threads: readonly { readonly title: string }[];
    };
    expect(output.threads[0]?.title).toBe("Refreshed title");
    expect(snapshotRequests).toBe(2);
    expect(eventRequests).toBe(3);
  });

  it("lets --agent override ZERO_AGENT_ID", async () => {
    server.use(
      http.get(SNAPSHOT_URL, () => {
        return HttpResponse.json({
          chatThreads: [
            snapshotThread({
              id: THREAD_ID,
              agentId: AGENT_ID,
              title: "Current agent",
              sortAt: "2026-07-24T03:00:00.000Z",
            }),
            snapshotThread({
              id: OTHER_THREAD_ID,
              agentId: OTHER_AGENT_ID,
              title: "Selected agent",
              sortAt: "2026-07-24T04:00:00.000Z",
            }),
          ],
          latestEventId: INITIAL_EVENT_ID,
          latestSeqId: INITIAL_SEQ_ID,
        });
      }),
      http.get(EVENTS_URL, () => {
        return HttpResponse.json({ events: [], hasMore: false });
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "list",
      "--agent",
      OTHER_AGENT_ID,
      "--limit",
      "1",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        agentId: OTHER_AGENT_ID,
        total: 1,
        threads: [
          expect.objectContaining({
            id: OTHER_THREAD_ID,
            title: "Selected agent",
          }),
        ],
      },
    );
  });

  it("requires an agent id from --agent or ZERO_AGENT_ID", async () => {
    vi.stubEnv("ZERO_AGENT_ID", "");

    await expect(async () => {
      await zeroChatCommand.parseAsync(["node", "cli", "list"]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("ZERO_AGENT_ID is not set");
    expect(stderr).toContain("Pass --agent <agent-id>");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
