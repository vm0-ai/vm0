import {
  chatThreadsContract,
  chatThreadEventsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { openDB } from "idb";
import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import {
  testContext,
  chatEventRowsResponse,
} from "../../signals/__tests__/test-helpers.ts";
import { CHAT_IDB_VERSION } from "../../signals/external/chat-idb-schema.ts";
import { createChildAbortController } from "../../signals/utils.ts";
import type {
  ChatEventDataKey,
  ChatThreadEventDataKey,
  SharedDatabaseIdentity,
  SharedDatabaseQuery,
} from "../data-key.ts";
import type { SharedDatabaseWorkerMessage } from "../protocol.ts";
import {
  bootstrapSharedDatabaseWorker$,
  connectSharedDatabaseWorkerClient$,
  heartbeatSharedDatabaseWorker$,
  querySharedDatabaseWorker$,
  subscribeSharedDatabaseWorker$,
} from "../worker-signals.ts";
import { SharedDatabaseWorkerRuntime } from "../worker-runtime.ts";
import { createSharedDatabaseContractClientFactory } from "../worker-client.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();
const SNAPSHOT_URL = "https://r2.example.com/shared-worker-chat-events.ndjson";
const CREATED_AT = "2026-08-14T08:00:00.000Z";
const WORKER_APP_VERSION = "shared-worker-store-version";

function chatEventSchemaVersionResponseHeaders(): Record<string, string> {
  return {
    [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
  };
}

type WorkerEvent = Extract<
  SharedDatabaseWorkerMessage,
  {
    readonly type:
      | "append"
      | "invalidate"
      | "authentication-required"
      | "indicators-invalidated"
      | "reload-required"
      | "status";
  }
>;

function identity(): SharedDatabaseIdentity {
  return {
    userId: `shared-worker-user-${context.resourceId}`,
    orgId: `shared-worker-org-${context.resourceId}`,
    token: "initial-token",
  };
}

function realtimeChannel(current: SharedDatabaseIdentity = identity()): string {
  return `user-org:${current.userId}:${current.orgId}`;
}

function chatEventKey(threadId: string): ChatEventDataKey {
  const current = identity();
  return {
    kind: "chat-event",
    userId: current.userId,
    orgId: current.orgId,
    threadId,
  };
}

function chatThreadEventKey(): ChatThreadEventDataKey {
  const current = identity();
  return {
    kind: "chat-thread-event",
    userId: current.userId,
    orgId: current.orgId,
  };
}

function chatEventRow(threadId: string, seqId: number): ChatEventRow {
  return {
    id: crypto.randomUUID(),
    chatThreadId: threadId,
    runId: null,
    revokesEventId: null,
    eventType: "output.message",
    payload: { content: `message ${seqId}` },
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId,
    createdAt: CREATED_AT,
  };
}

const AGENT_ID = "c0000000-0000-4000-a000-000000000920";
const THREAD_ID = "b0000000-0000-4000-a000-000000000920";

function snapshotThread(title: string): ChatThreadSnapshotProjection {
  return {
    id: THREAD_ID,
    agentId: AGENT_ID,
    title,
    sortAt: CREATED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    pinnedAt: null,
    renamedAt: null,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
  };
}

function renamedThreadEvent(seqId: number, title: string): ChatThreadEvent {
  return {
    id: crypto.randomUUID(),
    seqId,
    kind: "renamed",
    chatThreadId: THREAD_ID,
    agentId: AGENT_ID,
    title,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    createdAt: CREATED_AT,
  };
}

function snapshotNdjson(rows: readonly ChatEventRow[]): string {
  return `${rows
    .map((row) => {
      return JSON.stringify(row);
    })
    .join("\n")}\n`;
}

async function connectRuntime(
  events: WorkerEvent[] = [],
  vercelProtectionBypass?: string,
): Promise<string> {
  return await connectRuntimeWithIdentity(
    identity(),
    events,
    vercelProtectionBypass,
  );
}

async function connectRuntimeWithIdentity(
  currentIdentity: SharedDatabaseIdentity,
  events: WorkerEvent[] = [],
  vercelProtectionBypass?: string,
): Promise<string> {
  const clientId = crypto.randomUUID();
  context.workerStore.set(
    bootstrapSharedDatabaseWorker$,
    WORKER_APP_VERSION,
    context.signal,
  );
  context.workerStore.set(
    connectSharedDatabaseWorkerClient$,
    clientId,
    (event) => {
      events.push(event);
    },
  );
  await context.workerStore.set(
    heartbeatSharedDatabaseWorker$,
    clientId,
    {
      identity: currentIdentity,
      apiBaseUrl: location.origin,
      ...(vercelProtectionBypass ? { vercelProtectionBypass } : {}),
    },
    context.signal,
  );
  return clientId;
}

async function query<TKey extends ChatEventDataKey | ChatThreadEventDataKey>(
  clientId: string,
  value: SharedDatabaseQuery<TKey>,
  signal: AbortSignal = context.signal,
) {
  return await context.workerStore.set(
    querySharedDatabaseWorker$,
    clientId,
    value,
    signal,
  );
}

describe("shared database worker runtime", () => {
  it("forwards the dedicated Preview bypass to every API contract request", async () => {
    const bypassByRoute = new Map<string, (string | null)[]>();
    const recordBypass = (route: string, request: Request): void => {
      const values = bypassByRoute.get(route) ?? [];
      values.push(request.headers.get("x-vercel-protection-bypass"));
      bypassByRoute.set(route, values);
    };
    context.mocks.api(
      platformRealtimeTokenContract.create,
      ({ request, respond }) => {
        recordBypass("realtime-token", request);
        return respond(200, {
          keyName: "mock-key",
          clientId: "test-user-123",
          timestamp: Date.parse(CREATED_AT),
          capability: '{"*":["*"]}',
          nonce: "mock-nonce",
          mac: "mock-mac",
        });
      },
    );
    context.mocks.api(
      chatThreadEventsContract.snapshot,
      ({ request, respond }) => {
        recordBypass("chat-event-snapshot", request);
        return respond(404, {
          error: {
            code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
            message: "Chat event snapshot not found",
          },
        });
      },
    );
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query, request, respond }) => {
        recordBypass("chat-event-rows", request);
        return respond(200, chatEventRowsResponse([], query));
      },
    );
    context.mocks.api(chatThreadsContract.snapshot, ({ request, respond }) => {
      recordBypass("chat-thread-snapshot", request);
      return respond(200, {
        chatThreads: [],
        latestEventId: null,
        latestSeqId: null,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ request, respond }) => {
      recordBypass("chat-thread-events", request);
      return respond(200, { events: [], hasMore: false });
    });

    const clientId = await connectRuntime([], "preview-secret");
    context.workerStore.set(
      subscribeSharedDatabaseWorker$,
      clientId,
      crypto.randomUUID(),
      chatThreadEventKey(),
    );
    await vi.waitFor(() => {
      expect(bypassByRoute.get("realtime-token")).toStrictEqual([
        "preview-secret",
      ]);
    });
    await query(clientId, {
      dataKey: chatEventKey(crypto.randomUUID()),
      afterSeqId: null,
      consistency: "catch-up",
    });
    await query(clientId, {
      dataKey: chatThreadEventKey(),
      afterSeqId: null,
      consistency: "catch-up",
    });

    expect(Array.from(bypassByRoute.keys()).sort()).toStrictEqual(
      [
        "chat-event-rows",
        "chat-event-snapshot",
        "chat-thread-events",
        "chat-thread-snapshot",
        "realtime-token",
      ].sort(),
    );
    for (const values of bypassByRoute.values()) {
      expect(values.length).toBeGreaterThan(0);
      expect(
        values.every((value) => {
          return value === "preview-secret";
        }),
      ).toBeTruthy();
    }
  });

  it("uses the app version initialized in the worker Store", async () => {
    const observedVersions: (string | null)[] = [];
    context.mocks.api(
      chatThreadEventsContract.snapshot,
      ({ request, respond }) => {
        observedVersions.push(request.headers.get("x-client-version"));
        return respond(404, {
          error: {
            code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
            message: "Chat event snapshot not found",
          },
        });
      },
    );
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query: requestQuery, request, respond }) => {
        observedVersions.push(request.headers.get("x-client-version"));
        return respond(200, chatEventRowsResponse([], requestQuery));
      },
    );

    const clientId = await connectRuntime();
    await query(clientId, {
      dataKey: chatEventKey(crypto.randomUUID()),
      afterSeqId: null,
      consistency: "catch-up",
    });

    expect(observedVersions.length).toBeGreaterThan(0);
    expect(
      observedVersions.every((version) => {
        return version === WORKER_APP_VERSION;
      }),
    ).toBeTruthy();
  });

  it("omits the Preview bypass outside Preview", async () => {
    const observedBypassHeaders: (string | null)[] = [];
    context.mocks.api(
      chatThreadEventsContract.snapshot,
      ({ request, respond }) => {
        observedBypassHeaders.push(
          request.headers.get("x-vercel-protection-bypass"),
        );
        return respond(404, {
          error: {
            code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
            message: "Chat event snapshot not found",
          },
        });
      },
    );
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query, request, respond }) => {
        observedBypassHeaders.push(
          request.headers.get("x-vercel-protection-bypass"),
        );
        return respond(200, chatEventRowsResponse([], query));
      },
    );

    const clientId = await connectRuntime();
    await query(clientId, {
      dataKey: chatEventKey(crypto.randomUUID()),
      afterSeqId: null,
      consistency: "catch-up",
    });

    expect(observedBypassHeaders.length).toBeGreaterThanOrEqual(2);
    expect(
      observedBypassHeaders.every((value) => {
        return value === null;
      }),
    ).toBeTruthy();
  });

  it("keeps full cache-only queries for both datasets off the network", async () => {
    const clientId = await connectRuntime();
    let networkRequests = 0;
    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      networkRequests += 1;
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      networkRequests += 1;
      return respond(200, chatEventRowsResponse([], query));
    });
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      networkRequests += 1;
      return respond(200, {
        chatThreads: [],
        latestEventId: null,
        latestSeqId: null,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      networkRequests += 1;
      return respond(200, { events: [], hasMore: false });
    });

    await expect(
      query(clientId, {
        dataKey: chatEventKey(crypto.randomUUID()),
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([]);
    await expect(
      query(clientId, {
        dataKey: chatThreadEventKey(),
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual({ snapshot: null, events: [] });

    expect(networkRequests).toBe(0);
  });

  it("catches up both datasets after delayed first Ably attachment", async () => {
    const workerEvents: WorkerEvent[] = [];
    const attachment = context.mocks.ably.deferNextSubscribe();
    const clientId = await connectRuntime(workerEvents);
    const eventDataKey = chatEventKey(crypto.randomUUID());
    const threadDataKey = chatThreadEventKey();
    const firstRow = chatEventRow(eventDataKey.threadId, 1);
    const secondRow = chatEventRow(eventDataKey.threadId, 2);
    const renamedEvent = renamedThreadEvent(2, "new title");
    let availableRows: readonly ChatEventRow[] = [firstRow];
    let availableThreadEvents: readonly ChatThreadEvent[] = [];

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query, query: requestQuery, respond }) => {
        return respond(
          200,
          chatEventRowsResponse(
            availableRows.filter((row) => {
              return row.seqId > requestQuery.sinceSeqId;
            }),
            query,
          ),
        );
      },
    );
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: [snapshotThread("old title")],
        latestEventId: crypto.randomUUID(),
        latestSeqId: 1,
      });
    });
    context.mocks.api(
      chatThreadsContract.events,
      ({ query: requestQuery, respond }) => {
        return respond(200, {
          events: availableThreadEvents.filter((event) => {
            return (
              requestQuery.sinceSeqId === undefined ||
              event.seqId > requestQuery.sinceSeqId
            );
          }),
          hasMore: false,
        });
      },
    );

    context.workerStore.set(
      subscribeSharedDatabaseWorker$,
      clientId,
      crypto.randomUUID(),
      eventDataKey,
    );
    context.workerStore.set(
      subscribeSharedDatabaseWorker$,
      clientId,
      crypto.randomUUID(),
      threadDataKey,
    );
    await attachment.started;

    await expect(
      query(clientId, {
        dataKey: eventDataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual([firstRow]);
    await expect(
      query(clientId, {
        dataKey: threadDataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual({
      snapshot: {
        chatThreads: [snapshotThread("old title")],
        latestEventId: expect.any(String),
        latestSeqId: 1,
      },
      events: [],
    });
    const appendCountBeforeAttach = workerEvents.filter((event) => {
      return event.type === "append";
    }).length;

    availableRows = [firstRow, secondRow];
    availableThreadEvents = [renamedEvent];
    attachment.attach();

    await vi.waitFor(() => {
      expect(
        workerEvents.filter((event) => {
          return event.type === "append";
        }),
      ).toHaveLength(appendCountBeforeAttach + 2);
    });
    await expect(
      query(clientId, {
        dataKey: eventDataKey,
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([firstRow, secondRow]);
    await expect(
      query(clientId, {
        dataKey: threadDataKey,
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual({
      snapshot: {
        chatThreads: [snapshotThread("old title")],
        latestEventId: expect.any(String),
        latestSeqId: 1,
      },
      events: [renamedEvent],
    });
  });

  it("keeps a failed first Ably attachment disconnected", async () => {
    const workerEvents: WorkerEvent[] = [];
    context.mocks.ably.rejectNextSubscribe("channel attach failed");
    const clientId = await connectRuntime(workerEvents);
    let snapshotRequests = 0;
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      snapshotRequests += 1;
      return respond(200, {
        chatThreads: [],
        latestEventId: null,
        latestSeqId: null,
      });
    });
    context.workerStore.set(
      subscribeSharedDatabaseWorker$,
      clientId,
      crypto.randomUUID(),
      chatThreadEventKey(),
    );

    await vi.waitFor(() => {
      expect(workerEvents.at(-1)).toMatchObject({
        type: "status",
        status: "disconnected",
      });
    });
    expect(snapshotRequests).toBe(0);
  });

  it("rejects a missing ChatEvent response schema version", async () => {
    const clientId = await connectRuntime();
    const dataKey = chatEventKey(crypto.randomUUID());
    context.mocks.http.get(
      `*/api/chat-threads/${dataKey.threadId}/event-snapshot`,
      () => {
        return HttpResponse.json(
          {
            error: {
              code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
              message: "Chat event snapshot not found",
            },
          },
          { status: 404 },
        );
      },
    );

    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).rejects.toThrow("Unexpected Chat Event schema version null");
  });

  it("rejects a mismatched ChatEvent response schema version", async () => {
    const clientId = await connectRuntime();
    const dataKey = chatEventKey(crypto.randomUUID());
    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.http.get(
      `*/api/chat-threads/${dataKey.threadId}/event-rows`,
      () => {
        return HttpResponse.json(
          {
            rows: [],
            cursor: { lastEventId: null, lastSeqId: 0 },
            hasMore: false,
          },
          {
            headers: { [CHAT_EVENT_SCHEMA_VERSION_HEADER]: "999" },
          },
        );
      },
    );

    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).rejects.toThrow("Unexpected Chat Event schema version 999");
  });

  it("loads a ChatEvent snapshot plus tail and serves strict cursor reads from cache", async () => {
    const workerEvents: WorkerEvent[] = [];
    const clientId = await connectRuntime(workerEvents);
    const dataKey = chatEventKey(crypto.randomUUID());
    const snapshotRow = chatEventRow(dataKey.threadId, 2);
    const tailRow = chatEventRow(dataKey.threadId, 3);
    const requestedSeqIds: number[] = [];

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(200, {
        url: SNAPSHOT_URL,
        expiresInSeconds: 900,
        lastEventId: snapshotRow.id,
        lastSeqId: 2,
      });
    });
    context.mocks.http.get(SNAPSHOT_URL, () => {
      return new Response(snapshotNdjson([snapshotRow]));
    });
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query, query: requestQuery, respond }) => {
        requestedSeqIds.push(requestQuery.sinceSeqId);
        return respond(
          200,
          chatEventRowsResponse(
            requestQuery.sinceSeqId === 2 ? [tailRow] : [],
            query,
          ),
        );
      },
    );
    context.workerStore.set(
      subscribeSharedDatabaseWorker$,
      clientId,
      crypto.randomUUID(),
      dataKey,
    );

    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual([snapshotRow, tailRow]);
    expect(requestedSeqIds).toStrictEqual([2, 3]);
    expect(
      workerEvents.filter((event) => {
        return event.type === "append";
      }),
    ).toHaveLength(1);

    const requestCount = requestedSeqIds.length;
    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: 2,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([tailRow]);
    expect(requestedSeqIds).toHaveLength(requestCount);
  });

  it("shares catch-up work while allowing one caller to cancel its wait", async () => {
    const clientId = await connectRuntime();
    const dataKey = chatEventKey(crypto.randomUUID());
    const row = chatEventRow(dataKey.threadId, 1);
    const firstPage = context.mocks.deferred<void>();
    const requestedSeqIds: number[] = [];

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.api(
      chatThreadEventsContract.rows,
      async ({ query, query: requestQuery, respond }) => {
        requestedSeqIds.push(requestQuery.sinceSeqId);
        if (requestQuery.sinceSeqId === 0) {
          await firstPage.promise;
          return respond(200, chatEventRowsResponse([row], query));
        }
        return respond(200, chatEventRowsResponse([], query));
      },
    );

    const cancelled = createChildAbortController(context.signal);
    const first = query(
      clientId,
      { dataKey, afterSeqId: null, consistency: "catch-up" },
      cancelled.signal,
    );
    const second = query(clientId, {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up",
    });

    await vi.waitFor(() => {
      expect(requestedSeqIds).toStrictEqual([0]);
    });
    cancelled.abort(new DOMException("caller left", "AbortError"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    firstPage.resolve(undefined);

    await expect(second).resolves.toStrictEqual([row]);
    expect(requestedSeqIds).toStrictEqual([0, 1]);
  });

  it("invalidates before catch-up, coalesces repeats, and writes before append", async () => {
    const workerEvents: WorkerEvent[] = [];
    const clientId = await connectRuntime(workerEvents);
    const dataKey = chatEventKey(crypto.randomUUID());
    const firstRow = chatEventRow(dataKey.threadId, 1);
    const secondRow = chatEventRow(dataKey.threadId, 2);
    const thirdRow = chatEventRow(dataKey.threadId, 3);
    let availableRows: readonly ChatEventRow[] = [firstRow];
    const requestedSeqIds: number[] = [];
    const realtimePageStarted = context.mocks.deferred<void>();
    const releaseRealtimePage = context.mocks.deferred<void>();
    let holdRealtimePage = false;

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.api(
      chatThreadEventsContract.rows,
      async ({ query, query: requestQuery, respond }) => {
        requestedSeqIds.push(requestQuery.sinceSeqId);
        const rows = availableRows.filter((row) => {
          return row.seqId > requestQuery.sinceSeqId;
        });
        if (holdRealtimePage && requestQuery.sinceSeqId === 1) {
          realtimePageStarted.resolve(undefined);
          await releaseRealtimePage.promise;
        }
        return respond(200, chatEventRowsResponse(rows, query));
      },
    );
    context.workerStore.set(
      subscribeSharedDatabaseWorker$,
      clientId,
      crypto.randomUUID(),
      dataKey,
    );
    await query(clientId, {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up",
    });
    const appendCountBeforeRealtime = workerEvents.filter((event) => {
      return event.type === "append";
    }).length;
    const invalidationCountBeforeRealtime = workerEvents.filter((event) => {
      return event.type === "invalidate";
    }).length;

    availableRows = [firstRow, secondRow];
    holdRealtimePage = true;
    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      `chatThreadMessageCreated:${dataKey.threadId}`,
    );
    await realtimePageStarted.promise;
    expect(
      workerEvents.filter((event) => {
        return event.type === "invalidate";
      }),
    ).toHaveLength(invalidationCountBeforeRealtime + 1);
    expect(
      workerEvents.filter((event) => {
        return event.type === "append";
      }),
    ).toHaveLength(appendCountBeforeRealtime);
    availableRows = [firstRow, secondRow, thirdRow];
    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      `chatThreadMessageCreated:${dataKey.threadId}`,
    );
    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      `chatThreadMessageCreated:${dataKey.threadId}`,
    );
    releaseRealtimePage.resolve(undefined);

    await vi.waitFor(() => {
      expect(
        workerEvents.filter((event) => {
          return event.type === "append";
        }),
      ).toHaveLength(3);
    });
    expect(requestedSeqIds).toStrictEqual([0, 1, 1, 2]);
    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: 1,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([secondRow, thirdRow]);
  });

  it("caches realtime chat events without a page subscription", async () => {
    const workerEvents: WorkerEvent[] = [];
    const clientId = await connectRuntime(workerEvents);
    const dataKey = chatEventKey(crypto.randomUUID());
    const firstRow = chatEventRow(dataKey.threadId, 1);
    const secondRow = chatEventRow(dataKey.threadId, 2);
    let availableRows: readonly ChatEventRow[] = [firstRow];
    let rowsRequests = 0;

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query: requestQuery, respond }) => {
        rowsRequests += 1;
        return respond(
          200,
          chatEventRowsResponse(
            availableRows.filter((row) => {
              return row.seqId > requestQuery.sinceSeqId;
            }),
            requestQuery,
          ),
        );
      },
    );

    await vi.waitFor(() => {
      expect(workerEvents.at(-1)).toMatchObject({
        type: "status",
        status: "connected",
      });
      expect(
        context.mocks.ably.hasChannelSubscriptionOnChannel(realtimeChannel()),
      ).toBeTruthy();
    });
    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      `chatThreadMessageCreated:${dataKey.threadId}`,
    );

    await vi.waitFor(() => {
      expect(rowsRequests).toBeGreaterThan(0);
    });

    await vi.waitFor(async () => {
      await expect(
        query(clientId, {
          dataKey,
          afterSeqId: null,
          consistency: "cache-only",
        }),
      ).resolves.toStrictEqual([firstRow]);
    });

    availableRows = [firstRow, secondRow];
    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      `chatThreadMessageCreated:${dataKey.threadId}`,
    );
    await vi.waitFor(async () => {
      await expect(
        query(clientId, {
          dataKey,
          afterSeqId: null,
          consistency: "cache-only",
        }),
      ).resolves.toStrictEqual([firstRow, secondRow]);
    });
    expect(
      workerEvents.filter((event) => {
        return event.type === "append";
      }),
    ).toHaveLength(0);
  });

  it("releases an auth-blocked background actor after its last client disconnects", async () => {
    const workerEvents: WorkerEvent[] = [];
    const clientId = crypto.randomUUID();
    const dataKey = chatEventKey(crypto.randomUUID());
    const requestStarted = context.mocks.deferred<void>();
    const releaseResponse = context.mocks.deferred<void>();
    const runtime = new SharedDatabaseWorkerRuntime(
      context.signal,
      createSharedDatabaseContractClientFactory(WORKER_APP_VERSION),
    );

    context.mocks.api(
      chatThreadEventsContract.snapshot,
      async ({ respond }) => {
        requestStarted.resolve(undefined);
        await releaseResponse.promise;
        return respond(401, {
          error: { code: "UNAUTHORIZED", message: "token expired" },
        });
      },
    );

    runtime.connectClient(clientId, (event) => {
      workerEvents.push(event);
    });
    await runtime.heartbeat(
      clientId,
      undefined,
      identity(),
      location.origin,
      undefined,
    );
    await vi.waitFor(() => {
      expect(workerEvents.at(-1)).toMatchObject({
        type: "status",
        status: "connected",
      });
    });

    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      `chatThreadMessageCreated:${dataKey.threadId}`,
    );
    await requestStarted.promise;
    runtime.disconnectClient(clientId);
    releaseResponse.resolve(undefined);

    await vi.waitFor(() => {
      expect(runtime).toMatchObject({
        actors: new Map(),
        clients: new Map(),
        credentials: new Map(),
        databases: new Map(),
        realtimeSessions: new Map(),
        realtimeStatuses: new Map(),
      });
    });
  });

  it("forwards indicator invalidations only to the matching user-org clients", async () => {
    const sharedUserId = `indicator-user-${context.resourceId}`;
    const orgAIdentity: SharedDatabaseIdentity = {
      userId: sharedUserId,
      orgId: `indicator-org-a-${context.resourceId}`,
      token: "indicator-org-a-token",
    };
    const orgBIdentity: SharedDatabaseIdentity = {
      userId: sharedUserId,
      orgId: `indicator-org-b-${context.resourceId}`,
      token: "indicator-org-b-token",
    };
    const orgAEvents: WorkerEvent[] = [];
    const orgBEvents: WorkerEvent[] = [];
    await connectRuntimeWithIdentity(orgAIdentity, orgAEvents);
    await connectRuntimeWithIdentity(orgBIdentity, orgBEvents);

    await vi.waitFor(() => {
      expect(
        context.mocks.ably.hasChannelSubscriptionOnChannel(
          realtimeChannel(orgAIdentity),
        ),
      ).toBeTruthy();
      expect(
        context.mocks.ably.hasChannelSubscriptionOnChannel(
          realtimeChannel(orgBIdentity),
        ),
      ).toBeTruthy();
    });

    const readCursorPayload = {
      threadId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      lastReadAt: null,
    };
    context.mocks.ably.triggerOnChannel(
      realtimeChannel(orgAIdentity),
      "threadListChanged",
    );
    context.mocks.ably.triggerOnChannel(
      realtimeChannel(orgAIdentity),
      "chatThreadReadCursorUpdated",
      readCursorPayload,
    );

    await vi.waitFor(() => {
      expect(
        orgAEvents.filter((event) => {
          return event.type === "indicators-invalidated";
        }),
      ).toStrictEqual([
        { type: "indicators-invalidated", payload: null },
        { type: "indicators-invalidated", payload: readCursorPayload },
      ]);
    });
    expect(
      orgBEvents.filter((event) => {
        return event.type === "indicators-invalidated";
      }),
    ).toStrictEqual([]);
  });

  it("isolates realtime sessions and background caches by user and org", async () => {
    const sharedUserId = `shared-worker-user-${context.resourceId}`;
    const orgAIdentity: SharedDatabaseIdentity = {
      userId: sharedUserId,
      orgId: `shared-worker-org-a-${context.resourceId}`,
      token: "org-a-token",
    };
    const orgBIdentity: SharedDatabaseIdentity = {
      userId: sharedUserId,
      orgId: `shared-worker-org-b-${context.resourceId}`,
      token: "org-b-token",
    };
    const otherUserOrgBIdentity: SharedDatabaseIdentity = {
      userId: `shared-worker-other-user-${context.resourceId}`,
      orgId: orgBIdentity.orgId,
      token: "other-user-org-b-token",
    };
    const threadId = crypto.randomUUID();
    const orgADataKey: ChatEventDataKey = {
      kind: "chat-event",
      userId: sharedUserId,
      orgId: orgAIdentity.orgId,
      threadId,
    };
    const orgBDataKey: ChatEventDataKey = {
      kind: "chat-event",
      userId: sharedUserId,
      orgId: orgBIdentity.orgId,
      threadId,
    };
    const orgARow = chatEventRow(threadId, 1);
    const orgBRow = chatEventRow(threadId, 2);

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ request, query: requestQuery, respond }) => {
        const rows =
          request.headers.get("authorization") === "Bearer org-a-token"
            ? [orgARow]
            : [orgBRow];
        return respond(
          200,
          chatEventRowsResponse(
            rows.filter((row) => {
              return row.seqId > requestQuery.sinceSeqId;
            }),
            requestQuery,
          ),
        );
      },
    );

    const orgAWorkerEvents: WorkerEvent[] = [];
    const orgBWorkerEvents: WorkerEvent[] = [];
    const otherUserOrgBWorkerEvents: WorkerEvent[] = [];
    const orgAClientId = await connectRuntimeWithIdentity(
      orgAIdentity,
      orgAWorkerEvents,
    );
    const orgBClientId = await connectRuntimeWithIdentity(
      orgBIdentity,
      orgBWorkerEvents,
    );
    await connectRuntimeWithIdentity(
      otherUserOrgBIdentity,
      otherUserOrgBWorkerEvents,
    );
    await vi.waitFor(() => {
      expect(orgAWorkerEvents.at(-1)).toMatchObject({
        type: "status",
        status: "connected",
      });
      expect(orgBWorkerEvents.at(-1)).toMatchObject({
        type: "status",
        status: "connected",
      });
      expect(otherUserOrgBWorkerEvents.at(-1)).toMatchObject({
        type: "status",
        status: "connected",
      });
      expect(
        context.mocks.ably.hasChannelSubscriptionOnChannel(
          realtimeChannel(orgAIdentity),
        ),
      ).toBeTruthy();
      expect(
        context.mocks.ably.hasChannelSubscriptionOnChannel(
          realtimeChannel(orgBIdentity),
        ),
      ).toBeTruthy();
      expect(
        context.mocks.ably.hasChannelSubscriptionOnChannel(
          realtimeChannel(otherUserOrgBIdentity),
        ),
      ).toBeTruthy();
      expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(3);
    });

    context.mocks.ably.triggerOnChannel(
      realtimeChannel(orgAIdentity),
      `chatThreadMessageCreated:${threadId}`,
    );
    await vi.waitFor(async () => {
      await expect(
        query(orgAClientId, {
          dataKey: orgADataKey,
          afterSeqId: null,
          consistency: "cache-only",
        }),
      ).resolves.toStrictEqual([orgARow]);
    });
    await expect(
      query(orgBClientId, {
        dataKey: orgBDataKey,
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([]);

    context.mocks.ably.triggerOnChannel(
      realtimeChannel(orgBIdentity),
      `chatThreadMessageCreated:${threadId}`,
    );
    await vi.waitFor(async () => {
      await expect(
        query(orgBClientId, {
          dataKey: orgBDataKey,
          afterSeqId: null,
          consistency: "cache-only",
        }),
      ).resolves.toStrictEqual([orgBRow]);
    });
  });

  it("retries one failed realtime catch-up without another notification", async () => {
    const workerEvents: WorkerEvent[] = [];
    const clientId = await connectRuntime(workerEvents);
    const dataKey = chatEventKey(crypto.randomUUID());
    const firstRow = chatEventRow(dataKey.threadId, 1);
    const secondRow = chatEventRow(dataKey.threadId, 2);
    let availableRows: readonly ChatEventRow[] = [firstRow];
    let failNextPage = false;
    let failedRequests = 0;

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.http.get(
      `*/api/chat-threads/${dataKey.threadId}/event-rows`,
      ({ request }) => {
        if (failNextPage) {
          failNextPage = false;
          failedRequests += 1;
          return HttpResponse.json(
            { error: { code: "INTERNAL_ERROR", message: "try again" } },
            {
              status: 500,
              headers: chatEventSchemaVersionResponseHeaders(),
            },
          );
        }
        const sinceSeqId = Number(
          new URL(request.url).searchParams.get("sinceSeqId"),
        );
        const rows = availableRows.filter((row) => {
          return row.seqId > sinceSeqId;
        });
        const lastRow = rows.at(-1);
        const requestUrl = new URL(request.url);
        const sinceEventId = requestUrl.searchParams.get("sinceEventId");
        return HttpResponse.json(
          {
            rows,
            cursor:
              lastRow === undefined
                ? sinceEventId === null
                  ? { lastEventId: null, lastSeqId: 0 }
                  : {
                      lastEventId: sinceEventId,
                      lastSeqId: sinceSeqId,
                    }
                : {
                    lastEventId: lastRow.id,
                    lastSeqId: lastRow.seqId,
                  },
            hasMore: false,
          },
          { headers: chatEventSchemaVersionResponseHeaders() },
        );
      },
    );

    context.workerStore.set(
      subscribeSharedDatabaseWorker$,
      clientId,
      crypto.randomUUID(),
      dataKey,
    );
    await vi.waitFor(async () => {
      await expect(
        query(clientId, {
          dataKey,
          afterSeqId: null,
          consistency: "cache-only",
        }),
      ).resolves.toStrictEqual([firstRow]);
    });
    const appendCountBeforeNotification = workerEvents.filter((event) => {
      return event.type === "append";
    }).length;

    availableRows = [firstRow, secondRow];
    failNextPage = true;
    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      `chatThreadMessageCreated:${dataKey.threadId}`,
    );

    await vi.waitFor(() => {
      expect(
        workerEvents.filter((event) => {
          return event.type === "append";
        }),
      ).toHaveLength(appendCountBeforeNotification + 1);
    });
    expect(failedRequests).toBe(1);
    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: 1,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([secondRow]);
  });

  it("keeps a reconnecting realtime session non-connected on heartbeat", async () => {
    const workerEvents: WorkerEvent[] = [];
    const clientId = await connectRuntime(workerEvents);
    context.workerStore.set(
      subscribeSharedDatabaseWorker$,
      clientId,
      crypto.randomUUID(),
      chatThreadEventKey(),
    );
    await vi.waitFor(() => {
      expect(workerEvents.at(-1)).toMatchObject({
        type: "status",
        status: "connected",
      });
    });

    context.mocks.ably.triggerConnectionState("disconnected");
    await vi.waitFor(() => {
      expect(workerEvents.at(-1)).toMatchObject({
        type: "status",
        status: "connecting",
      });
    });
    await context.workerStore.set(
      heartbeatSharedDatabaseWorker$,
      clientId,
      { identity: identity(), apiBaseUrl: location.origin },
      context.signal,
    );
    expect(workerEvents.at(-1)).toMatchObject({
      type: "status",
      status: "connecting",
    });
  });

  it("transparently rebuilds ChatEvent cache after cursor expiry", async () => {
    const clientId = await connectRuntime();
    const dataKey = chatEventKey(crypto.randomUUID());
    const oldRow = chatEventRow(dataKey.threadId, 1);
    const rebuiltRow = chatEventRow(dataKey.threadId, 10);
    const tailRow = chatEventRow(dataKey.threadId, 11);
    let expired = false;

    context.mocks.api(
      chatThreadEventsContract.snapshot,
      ({ request, respond }) => {
        expect(request.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
          CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
        );
        if (!expired) {
          return respond(404, {
            error: {
              code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
              message: "Chat event snapshot not found",
            },
          });
        }
        return respond(200, {
          url: SNAPSHOT_URL,
          expiresInSeconds: 900,
          lastEventId: rebuiltRow.id,
          lastSeqId: 10,
        });
      },
    );
    context.mocks.http.get(SNAPSHOT_URL, () => {
      return new Response(snapshotNdjson([rebuiltRow]));
    });
    let returnedExpiry = false;
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query, request, query: requestQuery, respond }) => {
        expect(request.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
          CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
        );
        if (!expired) {
          return respond(
            200,
            chatEventRowsResponse(
              requestQuery.sinceSeqId === 0 ? [oldRow] : [],
              query,
            ),
          );
        }
        if (requestQuery.sinceSeqId === 1 && !returnedExpiry) {
          returnedExpiry = true;
          return respond(410, {
            error: {
              code: "CHAT_EVENTS_EXPIRED",
              message: "Chat events cursor has expired",
            },
          });
        }
        return respond(
          200,
          chatEventRowsResponse(
            requestQuery.sinceSeqId === 10 ? [tailRow] : [],
            query,
          ),
        );
      },
    );

    await query(clientId, {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up",
    });
    expired = true;

    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: oldRow.seqId,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual([rebuiltRow, tailRow]);
    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([rebuiltRow, tailRow]);
  });

  it("transparently replaces the ChatThreadEvent baseline after cursor expiry", async () => {
    const clientId = await connectRuntime();
    const dataKey = chatThreadEventKey();
    const oldEvent = renamedThreadEvent(2, "old title");
    const currentEvent = renamedThreadEvent(11, "current title");
    let snapshotVersion = 1;
    let returnExpiry = false;

    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      const current = snapshotVersion === 1;
      return respond(200, {
        chatThreads: [
          snapshotThread(current ? "old snapshot" : "new snapshot"),
        ],
        latestEventId: crypto.randomUUID(),
        latestSeqId: current ? 1 : 10,
      });
    });
    context.mocks.api(
      chatThreadsContract.events,
      ({ query: requestQuery, respond }) => {
        if (returnExpiry && requestQuery.sinceSeqId === oldEvent.seqId) {
          returnExpiry = false;
          return respond(410, {
            error: {
              code: "CHAT_THREAD_EVENTS_EXPIRED",
              message: "Chat thread events cursor has expired",
            },
          });
        }
        if (snapshotVersion === 1) {
          return respond(200, { events: [oldEvent], hasMore: false });
        }
        return respond(200, {
          events: requestQuery.sinceSeqId === 10 ? [currentEvent] : [],
          hasMore: false,
        });
      },
    );

    await query(clientId, {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up",
    });
    snapshotVersion = 2;
    returnExpiry = true;

    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: oldEvent.seqId,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual({
      snapshot: {
        chatThreads: [snapshotThread("new snapshot")],
        latestEventId: expect.any(String),
        latestSeqId: 10,
      },
      events: [currentEvent],
    });
  });

  it("compacts a valid ChatThreadEvent cache above the event-log bound", async () => {
    const workerEvents: WorkerEvent[] = [];
    const clientId = await connectRuntime(workerEvents);
    const dataKey = chatThreadEventKey();
    const eventLog = Array.from({ length: 101 }, (_, index) => {
      return renamedThreadEvent(index + 1, `title ${index + 1}`);
    });
    const lastEvent = eventLog.at(-1)!;
    let compactSnapshotAvailable = false;
    let snapshotRequests = 0;
    const requestedSeqIds: (number | undefined)[] = [];

    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      snapshotRequests += 1;
      return compactSnapshotAvailable
        ? respond(200, {
            chatThreads: [snapshotThread("title 101")],
            latestEventId: lastEvent.id,
            latestSeqId: lastEvent.seqId,
          })
        : respond(200, {
            chatThreads: [snapshotThread("initial title")],
            latestEventId: null,
            latestSeqId: null,
          });
    });
    context.mocks.api(
      chatThreadsContract.events,
      ({ query: requestQuery, respond }) => {
        requestedSeqIds.push(requestQuery.sinceSeqId);
        return respond(200, {
          events: requestQuery.sinceSeqId === undefined ? eventLog : [],
          hasMore: false,
        });
      },
    );

    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual({
      snapshot: {
        chatThreads: [snapshotThread("initial title")],
        latestEventId: null,
        latestSeqId: null,
      },
      events: eventLog,
    });
    compactSnapshotAvailable = true;
    context.workerStore.set(
      subscribeSharedDatabaseWorker$,
      clientId,
      crypto.randomUUID(),
      dataKey,
    );

    await vi.waitFor(() => {
      expect(snapshotRequests).toBe(2);
    });
    const compacted = {
      snapshot: {
        chatThreads: [snapshotThread("title 101")],
        latestEventId: lastEvent.id,
        latestSeqId: lastEvent.seqId,
      },
      events: [],
    };
    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual(compacted);
    expect(requestedSeqIds).toStrictEqual([undefined, 101, 101]);
    expect(
      workerEvents.filter((event) => {
        return event.type === "append";
      }),
    ).toHaveLength(0);
  });

  it("rejects when a fresh ChatThreadEvent snapshot cursor is already expired", async () => {
    const clientId = await connectRuntime();
    const dataKey = chatThreadEventKey();
    let snapshotRequests = 0;
    let eventRequests = 0;

    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      snapshotRequests += 1;
      return respond(200, {
        chatThreads: [snapshotThread("fresh snapshot")],
        latestEventId: crypto.randomUUID(),
        latestSeqId: 10,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      eventRequests += 1;
      return respond(410, {
        error: {
          code: "CHAT_THREAD_EVENTS_EXPIRED",
          message: "Chat thread events cursor has expired",
        },
      });
    });

    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).rejects.toThrow(
      "ChatThreadEvent cursor expired immediately after a server snapshot",
    );
    expect(snapshotRequests).toBe(1);
    expect(eventRequests).toBe(1);
  });

  it("returns remote rows and notifies after versionchange makes IDB writes fail", async () => {
    const workerEvents: WorkerEvent[] = [];
    const clientId = await connectRuntime(workerEvents);
    const dataKey = chatEventKey(crypto.randomUUID());
    const remoteRow = chatEventRow(dataKey.threadId, 1);
    context.workerStore.set(
      subscribeSharedDatabaseWorker$,
      clientId,
      crypto.randomUUID(),
      dataKey,
    );
    await query(clientId, {
      dataKey,
      afterSeqId: null,
      consistency: "cache-only",
    });

    const upgradedDb = await openDB(
      `vm0-chat-${dataKey.userId}-${dataKey.orgId}`,
      CHAT_IDB_VERSION + 1,
    );
    context.signal.addEventListener("abort", () => {
      upgradedDb.close();
    });
    await vi.waitFor(() => {
      expect(
        workerEvents.filter((event) => {
          return event.type === "reload-required";
        }),
      ).toHaveLength(1);
    });

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      return respond(200, chatEventRowsResponse([remoteRow], query));
    });

    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual([remoteRow]);
    expect(
      workerEvents.filter((event) => {
        return event.type === "append";
      }),
    ).toHaveLength(1);
    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([]);

    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: remoteRow.seqId,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual([]);
    expect(
      workerEvents.filter((event) => {
        return event.type === "append";
      }),
    ).toHaveLength(1);
  });

  it("notifies only once when degraded ChatThreadEvent writes keep failing", async () => {
    const workerEvents: WorkerEvent[] = [];
    const clientId = await connectRuntime(workerEvents);
    const dataKey = chatThreadEventKey();
    const snapshotEventId = crypto.randomUUID();
    context.workerStore.set(
      subscribeSharedDatabaseWorker$,
      clientId,
      crypto.randomUUID(),
      dataKey,
    );
    await query(clientId, {
      dataKey,
      afterSeqId: null,
      consistency: "cache-only",
    });

    const upgradedDb = await openDB(
      `vm0-chat-${dataKey.userId}-${dataKey.orgId}`,
      CHAT_IDB_VERSION + 1,
    );
    context.signal.addEventListener("abort", () => {
      upgradedDb.close();
    });
    await vi.waitFor(() => {
      expect(
        workerEvents.filter((event) => {
          return event.type === "reload-required";
        }),
      ).toHaveLength(1);
    });

    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: [snapshotThread("degraded snapshot")],
        latestEventId: snapshotEventId,
        latestSeqId: 1,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });

    const expected = {
      snapshot: {
        chatThreads: [snapshotThread("degraded snapshot")],
        latestEventId: snapshotEventId,
        latestSeqId: 1,
      },
      events: [],
    };
    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual(expected);
    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: 1,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual(expected);
    expect(
      workerEvents.filter((event) => {
        return event.type === "append";
      }),
    ).toHaveLength(1);
  });

  it("blocks on 401 until heartbeat supplies a different token", async () => {
    const workerEvents: WorkerEvent[] = [];
    const secondClientEvents: WorkerEvent[] = [];
    const clientId = await connectRuntime(workerEvents);
    await connectRuntime(secondClientEvents);
    const dataKey = chatEventKey(crypto.randomUUID());
    const recoveredRow = chatEventRow(dataKey.threadId, 1);
    let authorized = false;
    const authorizationHeaders: (string | null)[] = [];
    context.workerStore.set(
      subscribeSharedDatabaseWorker$,
      clientId,
      crypto.randomUUID(),
      dataKey,
    );

    context.mocks.api(
      chatThreadEventsContract.snapshot,
      ({ request, respond }) => {
        authorizationHeaders.push(request.headers.get("authorization"));
        if (!authorized) {
          return respond(401, {
            error: { code: "UNAUTHORIZED", message: "token expired" },
          });
        }
        return respond(404, {
          error: {
            code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
            message: "Chat event snapshot not found",
          },
        });
      },
    );
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query, request, query: requestQuery, respond }) => {
        authorizationHeaders.push(request.headers.get("authorization"));
        return respond(
          200,
          chatEventRowsResponse(
            requestQuery.sinceSeqId === 0 ? [recoveredRow] : [],
            query,
          ),
        );
      },
    );

    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).rejects.toMatchObject({ name: "SharedDatabaseAuthBlockedError" });
    expect(authorizationHeaders).toStrictEqual(["Bearer initial-token"]);
    expect(
      workerEvents.filter((event) => {
        return event.type === "authentication-required";
      }),
    ).toHaveLength(1);
    expect(
      secondClientEvents.filter((event) => {
        return event.type === "authentication-required";
      }),
    ).toHaveLength(1);

    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      `chatThreadMessageCreated:${dataKey.threadId}`,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(authorizationHeaders).toStrictEqual(["Bearer initial-token"]);

    await context.workerStore.set(
      heartbeatSharedDatabaseWorker$,
      clientId,
      { identity: identity(), apiBaseUrl: location.origin },
      context.signal,
    );
    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).rejects.toMatchObject({ name: "SharedDatabaseAuthBlockedError" });
    expect(authorizationHeaders).toStrictEqual(["Bearer initial-token"]);
    expect(
      workerEvents.filter((event) => {
        return event.type === "authentication-required";
      }),
    ).toHaveLength(1);

    authorized = true;
    await context.workerStore.set(
      heartbeatSharedDatabaseWorker$,
      clientId,
      {
        identity: { ...identity(), token: "replacement-token" },
        apiBaseUrl: location.origin,
      },
      context.signal,
    );
    expect(authorizationHeaders).toStrictEqual([
      "Bearer initial-token",
      "Bearer replacement-token",
      "Bearer replacement-token",
      "Bearer replacement-token",
    ]);
    await expect(
      query(clientId, {
        dataKey,
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([recoveredRow]);
    expect(
      workerEvents.filter((event) => {
        return event.type === "append";
      }),
    ).toHaveLength(1);
  });
});
