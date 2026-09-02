import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  chatThreadsContract,
  chatThreadEventsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { createStore, type Store } from "ccstate";
import { openDB } from "idb";
import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { CHAT_IDB_VERSION } from "../../signals/external/chat-idb-schema.ts";
import { createAuthedContractClient } from "../../signals/api-client-base.ts";
import type { ApiClientFactory } from "../../signals/api-client.ts";
import type { ClerkTokenSource } from "../../signals/clerk-token.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../signals/utils.ts";
import type {
  ChatEventDataKey,
  ChatThreadEventDataKey,
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "../data-key.ts";
import type { SharedDatabasePortLike } from "../bridge.ts";
import {
  registerConnection$,
  connectionControllers$,
  connectionPorts$,
  reloadConnections$,
  type WorkerBroadcastMessage,
} from "../worker-context.ts";
import { SharedDatabaseWorkerRuntime } from "../worker-runtime.ts";
import {
  initializeSharedDatabaseWorker$,
  querySharedDatabaseWorker$,
  startSharedDatabaseWorkerDaemons$,
} from "../worker-signals.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();
const SNAPSHOT_URL = "https://r2.example.com/shared-worker-chat-events.ndjson";
const CREATED_AT = "2026-08-14T08:00:00.000Z";
const WORKER_APP_VERSION = "shared-worker-store-version";
const AGENT_ID = "c0000000-0000-4000-a000-000000000920";
const THREAD_ID = "b0000000-0000-4000-a000-000000000920";
const WORKER_TOKEN = "initial-token";

class CollectingPort implements SharedDatabasePortLike {
  readonly messages: WorkerBroadcastMessage[] = [];

  postMessage(value: unknown): void {
    this.messages.push(value as WorkerBroadcastMessage);
  }

  start(): void {}

  close(): void {}

  addEventListener(
    _type: "message",
    _listener: (event: MessageEvent<unknown>) => void,
  ): void {}

  removeEventListener(
    _type: "message",
    _listener: (event: MessageEvent<unknown>) => void,
  ): void {}
}

function identity(
  overrides: Partial<SharedDatabaseIdentity> = {},
): SharedDatabaseIdentity {
  return {
    userId: `shared-worker-user-${context.resourceId}`,
    orgId: `shared-worker-org-${context.resourceId}`,
    ...overrides,
  };
}

function realtimeChannel(current: SharedDatabaseIdentity = identity()): string {
  return `user-org:${current.userId}:${current.orgId}`;
}

function chatEventKey(threadId: string): ChatEventDataKey {
  return {
    kind: "chat-event",
    threadId,
  };
}

function chatThreadEventKey(): ChatThreadEventDataKey {
  return { kind: "chat-thread-event" };
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

interface RuntimeFixture {
  readonly events: WorkerBroadcastMessage[];
  readonly runtime: SharedDatabaseWorkerRuntime;
}

function clerkTokenSource(token = WORKER_TOKEN): ClerkTokenSource {
  return {
    addListener: () => {
      return () => {};
    },
    session: {
      getToken: () => {
        return Promise.resolve(token);
      },
    },
  };
}

function createRuntimeClientFactory(
  token = WORKER_TOKEN,
  vercelProtectionBypass?: string,
): ApiClientFactory {
  return (contract) => {
    return createAuthedContractClient(contract, {
      baseUrl: location.origin,
      clientVersion: WORKER_APP_VERSION,
      getRootSignal: () => {
        return context.signal;
      },
      getToken: () => {
        return Promise.resolve(token);
      },
      getVercelProtectionBypass: () => {
        return vercelProtectionBypass;
      },
      validateResponse: true,
    });
  };
}

function createWorkerStore(
  currentIdentity: SharedDatabaseIdentity = identity(),
): Store {
  const store = createStore();
  store.set(
    initializeSharedDatabaseWorker$,
    {
      appVersion: WORKER_APP_VERSION,
      identity: currentIdentity,
      apiBaseUrl: location.origin,
      clerk: Promise.resolve(clerkTokenSource()),
      oauthApiBaseUrl: location.origin,
      onForceUpgrade: () => {
        store.set(reloadConnections$);
      },
    },
    context.signal,
  );
  return store;
}

function startRuntime(
  currentIdentity: SharedDatabaseIdentity = identity(),
  vercelProtectionBypass?: string,
): RuntimeFixture {
  const events: WorkerBroadcastMessage[] = [];
  const runtime = new SharedDatabaseWorkerRuntime(
    {
      identity: currentIdentity,
      emit: (event) => {
        events.push(event);
      },
      createContractClient: createRuntimeClientFactory(
        WORKER_TOKEN,
        vercelProtectionBypass,
      ),
    },
    context.signal,
  );
  return { events, runtime };
}

async function queryRuntime<TKey extends SharedDatabaseDataKey>(
  runtime: SharedDatabaseWorkerRuntime,
  query: SharedDatabaseQuery<TKey>,
  signal: AbortSignal = context.signal,
): Promise<SharedDatabaseQueryResult<TKey>> {
  return await runtime.query(query, signal);
}

describe("shared database worker runtime", () => {
  it("owns independent tab connections inside one Worker Store", () => {
    const store = createWorkerStore();
    const firstController = createChildAbortController(context.signal);
    const secondController = createChildAbortController(context.signal);
    const firstPort = new CollectingPort();
    const secondPort = new CollectingPort();
    const firstSignal = store.set(
      registerConnection$,
      "first-connection",
      firstController,
      firstPort,
      firstController.signal,
    );
    const firstControllers = store.get(connectionControllers$);
    const secondSignal = store.set(
      registerConnection$,
      "second-connection",
      secondController,
      secondPort,
      secondController.signal,
    );

    expect(firstSignal).not.toBe(secondSignal);
    expect(firstControllers).toStrictEqual(
      new Map([["first-connection", firstController]]),
    );
    expect(store.get(connectionControllers$)).toStrictEqual(
      new Map([
        ["first-connection", firstController],
        ["second-connection", secondController],
      ]),
    );
    expect(store.get(connectionPorts$)).toStrictEqual(
      new Map([
        ["first-connection", firstPort],
        ["second-connection", secondPort],
      ]),
    );

    firstController.abort(
      new DOMException("first connection closed", "AbortError"),
    );
    expect(firstSignal.aborted).toBeTruthy();
    expect(secondSignal.aborted).toBeFalsy();
    expect(
      store.get(connectionControllers$).has("first-connection"),
    ).toBeFalsy();
    expect(store.get(connectionPorts$).has("first-connection")).toBeFalsy();

    secondController.abort(
      new DOMException("second connection closed", "AbortError"),
    );
    expect(secondSignal.aborted).toBeTruthy();
    expect(store.get(connectionControllers$).size).toBe(0);
    expect(store.get(connectionPorts$).size).toBe(0);
  });

  it("forwards the Preview bypass to every API contract request", async () => {
    const bypassByRoute = new Map<string, (string | null)[]>();
    const recordBypass = (route: string, request: Request): void => {
      expect(request.headers.get("x-client-version")).toBe(WORKER_APP_VERSION);
      const values = bypassByRoute.get(route) ?? [];
      values.push(request.headers.get("x-vercel-protection-bypass"));
      bypassByRoute.set(route, values);
    };
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

    const { runtime } = startRuntime(identity(), "preview-secret");
    await queryRuntime(runtime, {
      dataKey: chatEventKey(crypto.randomUUID()),
      afterSeqId: null,
      consistency: "catch-up",
    });
    await queryRuntime(runtime, {
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

  it("keeps full cache-only queries for both datasets off the network", async () => {
    const { runtime } = startRuntime();
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
      queryRuntime(runtime, {
        dataKey: chatEventKey(crypto.randomUUID()),
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([]);
    await expect(
      queryRuntime(runtime, {
        dataKey: chatThreadEventKey(),
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual({ snapshot: null, events: [] });
    expect(networkRequests).toBe(0);
  });

  it.each(["UnknownError", "TransactionInactiveError", "InvalidStateError"])(
    "reopens IndexedDB and retries a %s transaction once",
    async (errorName) => {
      const { runtime } = startRuntime();
      const dataKey = chatEventKey(crypto.randomUUID());
      const cachedRow = chatEventRow(dataKey.threadId, 1);
      context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
        return respond(404, {
          error: {
            code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
            message: "Chat event snapshot not found",
          },
        });
      });
      context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
        return respond(
          200,
          chatEventRowsResponse(
            query.sinceSeqId === 0 ? [cachedRow] : [],
            query,
          ),
        );
      });
      await queryRuntime(runtime, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      });
      const close = vi.spyOn(IDBDatabase.prototype, "close");
      const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
      transaction.mockImplementationOnce(() => {
        throw new DOMException("Injected transaction failure", errorName);
      });

      await expect(
        queryRuntime(runtime, {
          dataKey,
          afterSeqId: null,
          consistency: "cache-only",
        }),
      ).resolves.toStrictEqual([cachedRow]);
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry a failing IndexedDB transaction more than once", async () => {
    const { runtime } = startRuntime();
    const dataKey = chatEventKey(crypto.randomUUID());
    await queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "cache-only",
    });
    const close = vi.spyOn(IDBDatabase.prototype, "close");
    const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      transaction.mockImplementationOnce(() => {
        throw new DOMException("Injected transaction failure", "UnknownError");
      });
    }

    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([]);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("rejects missing and mismatched ChatEvent response schema versions", async () => {
    const missing = startRuntime().runtime;
    const missingKey = chatEventKey(crypto.randomUUID());
    context.mocks.http.get(
      `*/api/chat-threads/${missingKey.threadId}/event-snapshot`,
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
      queryRuntime(missing, {
        dataKey: missingKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).rejects.toThrow("Unexpected Chat Event schema version null");

    const mismatched = startRuntime().runtime;
    const mismatchedKey = chatEventKey(crypto.randomUUID());
    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.http.get(
      `*/api/chat-threads/${mismatchedKey.threadId}/event-rows`,
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
      queryRuntime(mismatched, {
        dataKey: mismatchedKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).rejects.toThrow("Unexpected Chat Event schema version 999");
  });

  it("loads a ChatEvent snapshot plus tail and serves strict cursor reads from cache", async () => {
    const { runtime } = startRuntime();
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

    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual([snapshotRow, tailRow]);
    expect(requestedSeqIds).toStrictEqual([2, 3]);
    const requestCount = requestedSeqIds.length;
    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: 2,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([tailRow]);
    expect(requestedSeqIds).toHaveLength(requestCount);
  });

  it("runs concurrent connection requests independently and aborts only one connection", async () => {
    const store = createWorkerStore();
    const firstController = createChildAbortController(context.signal);
    const secondController = createChildAbortController(context.signal);
    const firstSignal = store.set(
      registerConnection$,
      "first-connection",
      firstController,
      new CollectingPort(),
      firstController.signal,
    );
    const secondSignal = store.set(
      registerConnection$,
      "second-connection",
      secondController,
      new CollectingPort(),
      secondController.signal,
    );
    const dataKey = chatEventKey(crypto.randomUUID());
    const remoteRow = chatEventRow(dataKey.threadId, 1);
    const firstPage = context.mocks.deferred<void>();
    let initialPageRequests = 0;
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
      async ({ query, respond }) => {
        if (query.sinceSeqId === 0) {
          initialPageRequests += 1;
          await firstPage.promise;
          return respond(200, chatEventRowsResponse([remoteRow], query));
        }
        return respond(200, chatEventRowsResponse([], query));
      },
    );
    const request = {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up" as const,
    };

    const first = store.set(
      querySharedDatabaseWorker$,
      "first-connection",
      request,
      firstSignal,
    );
    const second = store.set(
      querySharedDatabaseWorker$,
      "second-connection",
      request,
      secondSignal,
    );
    await vi.waitFor(() => {
      expect(initialPageRequests).toBe(2);
    });
    firstController.abort(
      new DOMException("first connection closed", "AbortError"),
    );
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(secondSignal.aborted).toBeFalsy();

    firstPage.resolve(undefined);
    await expect(second).resolves.toStrictEqual([remoteRow]);
    expect(initialPageRequests).toBe(2);
  });

  it("broadcasts semantic realtime invalidations without fetching data", async () => {
    const store = createWorkerStore();
    const firstController = createChildAbortController(context.signal);
    const secondController = createChildAbortController(context.signal);
    const firstPort = new CollectingPort();
    const secondPort = new CollectingPort();
    store.set(
      registerConnection$,
      "first-connection",
      firstController,
      firstPort,
      firstController.signal,
    );
    store.set(
      registerConnection$,
      "second-connection",
      secondController,
      secondPort,
      secondController.signal,
    );
    let chatEventRequests = 0;
    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      chatEventRequests += 1;
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      chatEventRequests += 1;
      return respond(200, chatEventRowsResponse([], query));
    });
    const initialAttachment = context.mocks.ably.deferNextSubscribe();
    const daemon = store.set(startSharedDatabaseWorkerDaemons$);
    if (daemon) {
      context.track(daemon);
    }
    await initialAttachment.started;
    for (const port of [firstPort, secondPort]) {
      expect(
        port.messages.some((message) => {
          return message.type === "reconnect";
        }),
      ).toBeFalsy();
    }
    initialAttachment.attach();
    await vi.waitFor(() => {
      expect(
        context.mocks.ably.hasChannelSubscriptionOnChannel(realtimeChannel()),
      ).toBeTruthy();
    });
    for (const port of [firstPort, secondPort]) {
      expect(port.messages).not.toContainEqual({ type: "reconnect" });
    }
    const threadId = crypto.randomUUID();

    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      `chatThreadMessageCreated:${threadId}`,
    );

    await vi.waitFor(() => {
      for (const port of [firstPort, secondPort]) {
        expect(port.messages).toContainEqual({
          type: "invalidate",
          dataKey: chatEventKey(threadId),
        });
      }
    });
    const readCursorPayload = {
      threadId,
      lastReadAt: null,
    };
    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      "chatThreadReadCursorUpdated",
      readCursorPayload,
    );
    await vi.waitFor(() => {
      for (const port of [firstPort, secondPort]) {
        expect(port.messages).toContainEqual({
          type: "chat-thread-read-cursor-updated",
          payload: readCursorPayload,
        });
        expect(port.messages).toContainEqual({
          type: "reload-computed",
          computedKey: "chat-thread-indicators",
        });
      }
    });
    expect(chatEventRequests).toBe(0);
  });

  it("transparently rebuilds ChatEvent cache after cursor expiry", async () => {
    const { runtime } = startRuntime();
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

    await queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up",
    });
    expired = true;
    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: oldRow.seqId,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual([rebuiltRow, tailRow]);
    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([rebuiltRow, tailRow]);
  });

  it("transparently replaces the ChatThreadEvent baseline after cursor expiry", async () => {
    const { runtime } = startRuntime();
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
    context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
      if (returnExpiry && query.sinceSeqId === oldEvent.seqId) {
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
        events: query.sinceSeqId === 10 ? [currentEvent] : [],
        hasMore: false,
      });
    });

    await queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up",
    });
    snapshotVersion = 2;
    returnExpiry = true;
    await expect(
      queryRuntime(runtime, {
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

  it("rebases a valid ChatThreadEvent cache above the event-log bound on demand", async () => {
    const { runtime } = startRuntime();
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
    context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
      requestedSeqIds.push(query.sinceSeqId);
      return respond(200, {
        events: query.sinceSeqId === undefined ? eventLog : [],
        hasMore: false,
      });
    });

    await queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up",
    });
    compactSnapshotAvailable = true;
    const compacted = {
      snapshot: {
        chatThreads: [snapshotThread("title 101")],
        latestEventId: lastEvent.id,
        latestSeqId: lastEvent.seqId,
      },
      events: [],
    };
    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual(compacted);
    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual(compacted);
    expect(snapshotRequests).toBe(2);
    expect(requestedSeqIds).toStrictEqual([undefined, 101, 101]);
  });

  it("rejects when a fresh ChatThreadEvent snapshot cursor is already expired", async () => {
    const { runtime } = startRuntime();
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
      queryRuntime(runtime, {
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

  it("returns remote rows after versionchange makes IndexedDB writes fail", async () => {
    const currentIdentity = identity();
    const { events, runtime } = startRuntime(currentIdentity);
    const dataKey = chatEventKey(crypto.randomUUID());
    const remoteRow = chatEventRow(dataKey.threadId, 1);
    await queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "cache-only",
    });
    const upgradedDb = await openDB(
      `vm0-chat-${currentIdentity.userId}-${currentIdentity.orgId}`,
      CHAT_IDB_VERSION + 1,
    );
    context.signal.addEventListener("abort", () => {
      upgradedDb.close();
    });
    await vi.waitFor(() => {
      expect(
        events.filter((event) => {
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
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual([remoteRow]);
    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([]);
  });
});
