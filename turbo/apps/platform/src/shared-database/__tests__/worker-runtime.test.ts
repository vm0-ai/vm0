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
import { openDB } from "idb";
import { expect, test, vi } from "vitest";

import { CHAT_IDB_VERSION } from "../../signals/external/chat-idb-schema.ts";
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
import { SharedDatabaseWorkerContext } from "../worker-host-context.ts";
import {
  registerConnection$,
  setWorkerToken$,
  type WorkerBroadcastMessage,
} from "../worker-context.ts";
import { SharedDatabaseWorkerRuntime } from "../worker-runtime.ts";
import { createSharedDatabaseContractClientFactory } from "../worker-client.ts";
import {
  createSharedDatabaseCredentialStore,
  heartbeatSharedDatabaseWorker$,
  querySharedDatabaseWorker$,
} from "../worker-signals.ts";

const context = testContext();
const SNAPSHOT_URL = "https://r2.example.com/shared-worker-chat-events.ndjson";
const CREATED_AT = "2026-08-14T08:00:00.000Z";
const WORKER_APP_VERSION = "shared-worker-store-version";
const AGENT_ID = "c0000000-0000-4000-a000-000000000920";
const THREAD_ID = "b0000000-0000-4000-a000-000000000920";

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
    token: "initial-token",
    ...overrides,
  };
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

function startRuntime(
  currentIdentity: SharedDatabaseIdentity = identity(),
  vercelProtectionBypass?: string,
): RuntimeFixture {
  const events: WorkerBroadcastMessage[] = [];
  const runtime = new SharedDatabaseWorkerRuntime(
    {
      identity: currentIdentity,
      apiBaseUrl: location.origin,
      vercelProtectionBypass,
      authRecovery: {
        getToken: () => {
          return Promise.resolve(currentIdentity.token);
        },
        forceRefreshToken: () => {
          return Promise.resolve(currentIdentity.token);
        },
      },
      emit: (event) => {
        events.push(event);
      },
      createContractClient:
        createSharedDatabaseContractClientFactory(WORKER_APP_VERSION),
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

test("Isolate shared chat data by user and workspace", () => {
  const workerContext = new SharedDatabaseWorkerContext(
    context.signal,
    WORKER_APP_VERSION,
  );
  const firstIdentity = identity();
  const secondIdentity = identity({
    orgId: `${identity().orgId}-second`,
    token: "second-token",
  });
  const firstController = createChildAbortController(context.signal);
  const secondController = createChildAbortController(context.signal);
  const { binding: firstBinding } = workerContext.bindConnection({
    connectionId: "first-connection",
    connectionController: firstController,
    port: new CollectingPort(),
    identity: firstIdentity,
    apiBaseUrl: location.origin,
    vercelProtectionBypass: undefined,
  });
  const { binding: secondBinding } = workerContext.bindConnection({
    connectionId: "second-connection",
    connectionController: secondController,
    port: new CollectingPort(),
    identity: secondIdentity,
    apiBaseUrl: location.origin,
    vercelProtectionBypass: undefined,
  });

  expect(firstBinding.store).not.toBe(secondBinding.store);
  expect(workerContext.credentialStoreCount()).toBe(2);

  firstController.abort();
  expect(workerContext.credentialStoreCount()).toBe(1);
  secondController.abort();
  expect(workerContext.credentialStoreCount()).toBe(0);
});

test("Read locally cached chat data without the network", async () => {
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

test("Load complete chat history across a snapshot boundary", async () => {
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

test("Rebuild chat data after its saved cursor expires", async () => {
  {
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
  }
  {
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
  }
});
test("Continue online when local chat storage becomes unavailable", async () => {
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

test("Wait for a genuinely new token after authentication is rejected", async () => {
  const store = createSharedDatabaseCredentialStore(
    {
      appVersion: WORKER_APP_VERSION,
      identity: identity(),
      apiBaseUrl: location.origin,
      vercelProtectionBypass: undefined,
    },
    context.signal,
  );
  const firstPort = new CollectingPort();
  const secondPort = new CollectingPort();
  const firstController = createChildAbortController(context.signal);
  const secondController = createChildAbortController(context.signal);
  const firstSignal = store.set(
    registerConnection$,
    "first-connection",
    firstController,
    firstPort,
    firstController.signal,
  );
  const secondSignal = store.set(
    registerConnection$,
    "second-connection",
    secondController,
    secondPort,
    secondController.signal,
  );
  store.set(heartbeatSharedDatabaseWorker$, "first-connection", firstSignal);
  const dataKey = chatEventKey(crypto.randomUUID());
  const recoveredRow = chatEventRow(dataKey.threadId, 1);
  const authorizationHeaders: (string | null)[] = [];
  context.mocks.api(
    chatThreadEventsContract.snapshot,
    ({ request, respond }) => {
      const authorization = request.headers.get("authorization");
      authorizationHeaders.push(authorization);
      if (authorization !== "Bearer replacement-token") {
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
    ({ query, request, respond }) => {
      authorizationHeaders.push(request.headers.get("authorization"));
      return respond(
        200,
        chatEventRowsResponse(
          query.sinceSeqId === 0 ? [recoveredRow] : [],
          query,
        ),
      );
    },
  );
  const request = {
    dataKey,
    afterSeqId: null,
    consistency: "catch-up" as const,
  };

  const firstQuery = store.set(
    querySharedDatabaseWorker$,
    "first-connection",
    request,
    firstSignal,
  );
  await vi.waitFor(() => {
    expect(
      firstPort.messages.filter((event) => {
        return event.type === "authentication-required";
      }),
    ).toHaveLength(1);
  });
  for (const port of [firstPort, secondPort]) {
    expect(
      port.messages.filter((event) => {
        return event.type === "authentication-required";
      }),
    ).toHaveLength(1);
  }
  const authenticationRequest = firstPort.messages.find((event) => {
    return event.type === "authentication-required";
  });
  if (authenticationRequest?.type !== "authentication-required") {
    throw new Error("Authentication recovery was not requested");
  }
  store.set(
    setWorkerToken$,
    "first-connection",
    authenticationRequest.recoveryId,
    "initial-token",
  );
  await expect(firstQuery).rejects.toMatchObject({
    name: "SharedDatabaseHttpError",
  });
  expect(authorizationHeaders).toStrictEqual([
    "Bearer initial-token",
    "Bearer initial-token",
  ]);

  const recoveredQuery = store.set(
    querySharedDatabaseWorker$,
    "second-connection",
    request,
    secondSignal,
  );
  await vi.waitFor(() => {
    expect(
      secondPort.messages.filter((event) => {
        return event.type === "authentication-required";
      }),
    ).toHaveLength(2);
  });
  const freshAuthenticationRequest = secondPort.messages.at(-1);
  if (freshAuthenticationRequest?.type !== "authentication-required") {
    throw new Error("Fresh authentication recovery was not requested");
  }
  store.set(
    setWorkerToken$,
    "second-connection",
    freshAuthenticationRequest.recoveryId,
    "replacement-token",
  );
  await expect(recoveredQuery).resolves.toStrictEqual([recoveredRow]);
  expect(authorizationHeaders).toContain("Bearer replacement-token");
});
