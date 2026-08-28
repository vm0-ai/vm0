import { waitFor } from "@testing-library/react";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it, vi } from "vitest";

import { setupBootstrap } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  CHAT_EVENT_CURSOR_STORE,
  CHAT_EVENT_ROWS_STORE,
} from "../../external/chat-idb-schema.ts";
import { chatIdb$ } from "../../external/chat-idb-store.ts";
import { setupRealtime$ } from "../../realtime.ts";
import { resetSignal } from "../../utils.ts";
import { setupChatEventBackgroundSync$ } from "../chat-event-background-sync.ts";
import { writeIndexedDbChatEventRows$ } from "../chat-event-row-indexed-db.ts";
import { createChatEventSignals } from "../chat-event-signals.ts";
import { semanticChatEventsFromChatEvents } from "../chat-event-state.ts";
import { createChatEventStorageSignals } from "../chat-event-storage-signals.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();
const resetSubscriberSignal$ = resetSignal();

const SNAPSHOT_URL = "https://r2.example.com/chat-events/snapshot.ndjson.gz";
const CREATED_AT = "2026-08-08T10:00:00.000Z";

function userId(): string {
  return `snapshot-read-user-${context.resourceId}`;
}

function orgId(): string {
  return `snapshot-read-org-${context.resourceId}`;
}

async function openTestChatDb() {
  const db = await context.store.get(chatIdb$);
  context.signal.addEventListener(
    "abort",
    () => {
      db.close();
    },
    { once: true },
  );
  return db;
}

function baseRow(threadId: string, seqId: number): ChatEventRow {
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

function promptRow(
  threadId: string,
  seqId: number,
  text: string,
): ChatEventRow {
  return {
    ...baseRow(threadId, seqId),
    eventType: "input.prompt",
    contextType: "web",
    payload: {
      userMessage: {
        version: 1,
        parts: [{ type: "text", text }],
      },
    },
  };
}

function toolRow(threadId: string, seqId: number): ChatEventRow {
  return {
    ...baseRow(threadId, seqId),
    runId: crypto.randomUUID(),
    eventType: "output.tool",
    payload: {
      toolUseId: `tool-use-${seqId.toString()}`,
      action: "read",
      status: "success",
      summary: "Read the requested file",
    },
  };
}

interface ThreadFixture {
  readonly threadId: string;
  readonly promptEventRow: ChatEventRow;
  readonly assistantEventRow: ChatEventRow;
  readonly tailEventRow: ChatEventRow;
}

function threadFixture(): ThreadFixture {
  const threadId = crypto.randomUUID();
  return {
    threadId,
    promptEventRow: promptRow(threadId, 1, "snapshot prompt"),
    assistantEventRow: baseRow(threadId, 2),
    tailEventRow: baseRow(threadId, 3),
  };
}

function snapshotNdjson(rows: readonly ChatEventRow[]): string {
  return `${rows
    .map((row) => {
      return JSON.stringify(row);
    })
    .join("\n")}\n`;
}

function createSignals(threadId: string) {
  return createChatEventStorageSignals({ threadId });
}

async function writeCachedRows(rows: readonly ChatEventRow[]): Promise<void> {
  const lastRow = rows.at(-1);
  if (lastRow === undefined) {
    throw new Error("Expected cached Chat Event rows");
  }
  await context.store.set(
    writeIndexedDbChatEventRows$,
    {
      threadId: lastRow.chatThreadId,
      rows,
      cursor: { lastEventId: lastRow.id, lastSeqId: lastRow.seqId },
      schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
    },
    context.signal,
  );
}

async function setupAuthenticatedBootstrap(): Promise<void> {
  await setupBootstrap({
    context,
    path: "/error",
    user: {
      id: userId(),
      fullName: "Snapshot Read User",
      email: "snapshot-read@example.com",
    },
    session: { token: "test-token" },
    org: {
      activeOrg: { id: orgId(), name: "Snapshot Read Org" },
      memberships: [{ id: orgId() }],
    },
  });
}

describe("chat event snapshot read", () => {
  it("reads sparse snapshot positions and tails from its coverage", async () => {
    await setupAuthenticatedBootstrap();
    const threadId = crypto.randomUUID();
    const promptEventRow = promptRow(threadId, 5, "snapshot prompt");
    const assistantEventRow = baseRow(threadId, 8);
    const tailEventRow = baseRow(threadId, 12);
    const appDb = await openTestChatDb();

    context.mocks.api(
      chatThreadEventsContract.snapshot,
      ({ request, respond }) => {
        expect(request.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
          CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
        );
        return respond(200, {
          url: SNAPSHOT_URL,
          expiresInSeconds: 900,
          lastEventId: assistantEventRow.id,
          lastSeqId: assistantEventRow.seqId,
        });
      },
    );
    context.mocks.http.get(SNAPSHOT_URL, () => {
      return new Response(snapshotNdjson([promptEventRow, assistantEventRow]));
    });
    const rowRequests: number[] = [];
    const rowEventIds: (string | undefined)[] = [];
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query, request, respond }) => {
        expect(request.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
          CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
        );
        rowRequests.push(query.sinceSeqId);
        rowEventIds.push(query.sinceEventId);
        if (query.sinceSeqId === assistantEventRow.seqId) {
          return respond(200, { rows: [tailEventRow] });
        }
        return respond(200, { rows: [] });
      },
    );

    const signals = createSignals(threadId);
    await context.store.set(signals.initializeIndexedDbEvents$, context.signal);
    expect(context.store.get(signals.chatEvents$)).toHaveLength(0);

    await context.store.set(signals.syncRemoteEvents$, context.signal);

    const events = context.store.get(signals.chatEvents$);
    expect(
      events.map((event) => {
        return {
          id: event.id,
          seqId: event.seqId,
          eventType: event.eventType,
        };
      }),
    ).toStrictEqual([
      { id: promptEventRow.id, seqId: 5, eventType: "input.prompt" },
      { id: assistantEventRow.id, seqId: 8, eventType: "output.message" },
      { id: tailEventRow.id, seqId: 12, eventType: "output.message" },
    ]);
    const prompt = events[0];
    if (prompt?.eventType !== "input.prompt") {
      throw new Error("Expected a projected prompt event");
    }
    expect(prompt.userMessage).toStrictEqual({
      version: 1,
      parts: [{ type: "text", text: "snapshot prompt" }],
    });
    expect(prompt).not.toHaveProperty("contextType");
    expect(rowRequests).toStrictEqual([assistantEventRow.seqId, 12]);
    expect(rowEventIds).toStrictEqual([assistantEventRow.id, tailEventRow.id]);

    await expect(
      appDb.get(CHAT_EVENT_ROWS_STORE, tailEventRow.id),
    ).resolves.toStrictEqual(tailEventRow);
  });

  it("retries V6 once when an old API rejects V7 as ahead", async () => {
    await setupAuthenticatedBootstrap();
    const { threadId, promptEventRow, assistantEventRow } = threadFixture();
    const appDb = await openTestChatDb();
    const snapshotVersions: string[] = [];
    const rowVersions: string[] = [];

    context.mocks.api(
      chatThreadEventsContract.snapshot,
      ({ request, respond }) => {
        const version = request.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER);
        snapshotVersions.push(version ?? "missing");
        if (version === CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString()) {
          return respond(409, {
            error: {
              code: "CHAT_EVENT_SCHEMA_VERSION_AHEAD",
              message:
                "The requested Chat Event schema version is newer than this API",
            },
          });
        }
        expect(version).toBe(PREVIOUS_CHAT_EVENT_SCHEMA_VERSION.toString());
        return respond(200, {
          url: SNAPSHOT_URL,
          expiresInSeconds: 900,
          lastEventId: assistantEventRow.id,
          lastSeqId: assistantEventRow.seqId,
          projection: "tool-redacted",
        });
      },
    );
    context.mocks.http.get(SNAPSHOT_URL, () => {
      return new Response(snapshotNdjson([promptEventRow, assistantEventRow]));
    });
    context.mocks.api(chatThreadEventsContract.rows, ({ request, respond }) => {
      const version = request.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER);
      rowVersions.push(version ?? "missing");
      if (version === CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString()) {
        return respond(409, {
          error: {
            code: "CHAT_EVENT_SCHEMA_VERSION_AHEAD",
            message:
              "The requested Chat Event schema version is newer than this API",
          },
        });
      }
      expect(version).toBe(PREVIOUS_CHAT_EVENT_SCHEMA_VERSION.toString());
      return respond(200, {
        rows: [],
        cursor: {
          lastEventId: assistantEventRow.id,
          lastSeqId: assistantEventRow.seqId,
          projection: "tool-redacted",
        },
        hasMore: false,
        projection: "tool-redacted",
      });
    });

    const signals = createSignals(threadId);
    await context.store.set(signals.initializeIndexedDbEvents$, context.signal);
    await context.store.set(signals.syncRemoteEvents$, context.signal);

    expect(snapshotVersions).toStrictEqual([
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
      PREVIOUS_CHAT_EVENT_SCHEMA_VERSION.toString(),
    ]);
    expect(rowVersions).toStrictEqual([
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
      PREVIOUS_CHAT_EVENT_SCHEMA_VERSION.toString(),
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
      PREVIOUS_CHAT_EVENT_SCHEMA_VERSION.toString(),
    ]);
    expect(
      context.store.get(signals.chatEvents$).map((event) => {
        return event.id;
      }),
    ).toStrictEqual([promptEventRow.id, assistantEventRow.id]);
    await expect(
      appDb.get(CHAT_EVENT_CURSOR_STORE, threadId),
    ).resolves.toMatchObject({
      schemaVersion: PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
    });
  });

  it("cold-starts from the rows endpoint when the thread has no snapshot yet", async () => {
    await setupAuthenticatedBootstrap();
    const { threadId, promptEventRow, assistantEventRow } = threadFixture();
    const appDb = await openTestChatDb();

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    const rowRequests: number[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      rowRequests.push(query.sinceSeqId);
      if (query.sinceSeqId === 0) {
        return respond(200, {
          rows: [promptEventRow, assistantEventRow],
        });
      }
      return respond(200, { rows: [] });
    });

    const signals = createSignals(threadId);
    await context.store.set(signals.initializeIndexedDbEvents$, context.signal);
    await context.store.set(signals.syncRemoteEvents$, context.signal);

    expect(
      context.store.get(signals.chatEvents$).map((event) => {
        return { id: event.id, seqId: event.seqId };
      }),
    ).toStrictEqual([
      { id: promptEventRow.id, seqId: 1 },
      { id: assistantEventRow.id, seqId: 2 },
    ]);
    expect(rowRequests).toStrictEqual([0, 2]);
    await expect(
      appDb.get(CHAT_EVENT_ROWS_STORE, assistantEventRow.id),
    ).resolves.toStrictEqual(assistantEventRow);
  });

  it("keeps output.tool cache and cursors physical while the semantic gate changes", async () => {
    await setupAuthenticatedBootstrap();
    const threadId = crypto.randomUUID();
    const toolEventRow = toolRow(threadId, 1);
    const assistantEventRow = baseRow(threadId, 2);
    const appDb = await openTestChatDb();

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    const requests: {
      readonly seqId: number;
      readonly projection: string | undefined;
    }[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      requests.push({
        seqId: query.sinceSeqId,
        projection:
          "sinceProjection" in query ? query.sinceProjection : undefined,
      });
      if (query.sinceSeqId === 0) {
        return respond(200, {
          rows: [toolEventRow],
          cursor: {
            lastEventId: toolEventRow.id,
            lastSeqId: toolEventRow.seqId,
            projection: "full",
          },
          hasMore: true,
          projection: "full",
        });
      }
      if (query.sinceSeqId === toolEventRow.seqId) {
        return respond(200, {
          rows: [assistantEventRow],
          cursor: {
            lastEventId: assistantEventRow.id,
            lastSeqId: assistantEventRow.seqId,
            projection: "full",
          },
          hasMore: false,
          projection: "full",
        });
      }
      throw new Error(`Unexpected row cursor: ${JSON.stringify(query)}`);
    });

    const signals = createSignals(threadId);
    await context.store.set(signals.initializeIndexedDbEvents$, context.signal);
    await context.store.set(signals.syncRemoteEvents$, context.signal);

    const events = context.store.get(signals.chatEvents$);
    expect(
      events.map((event) => {
        return event.id;
      }),
    ).toStrictEqual([toolEventRow.id, assistantEventRow.id]);
    expect(
      semanticChatEventsFromChatEvents(events, false).map(({ event }) => {
        return event.id;
      }),
    ).toStrictEqual([assistantEventRow.id]);
    expect(
      semanticChatEventsFromChatEvents(events, true).map(({ event }) => {
        return event.id;
      }),
    ).toStrictEqual([toolEventRow.id, assistantEventRow.id]);
    expect(requests).toStrictEqual([
      { seqId: 0, projection: undefined },
      { seqId: 1, projection: "full" },
    ]);
    await expect(
      appDb.get(CHAT_EVENT_ROWS_STORE, toolEventRow.id),
    ).resolves.toStrictEqual(toolEventRow);
    await expect(
      appDb.get(CHAT_EVENT_ROWS_STORE, assistantEventRow.id),
    ).resolves.toStrictEqual(assistantEventRow);

    const replaySignals = createSignals(threadId);
    await context.store.set(
      replaySignals.initializeIndexedDbEvents$,
      context.signal,
    );
    const replayEvents = context.store.get(replaySignals.chatEvents$);
    expect(
      replayEvents.map((event) => {
        return event.id;
      }),
    ).toStrictEqual([toolEventRow.id, assistantEventRow.id]);
    expect(
      semanticChatEventsFromChatEvents(replayEvents, true).map(({ event }) => {
        return event.id;
      }),
    ).toStrictEqual([toolEventRow.id, assistantEventRow.id]);
  });

  it("fails loudly when the rows cursor expires right after a cold start", async () => {
    await setupAuthenticatedBootstrap();
    const { threadId } = threadFixture();

    // A head the reader refuses to serve: the snapshot endpoint fails closed
    // while the rows endpoint still expects that head's cursor.
    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    const rowRequests: number[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      rowRequests.push(query.sinceSeqId);
      return respond(410, {
        error: {
          code: "CHAT_EVENTS_EXPIRED",
          message: "Chat events cursor has expired",
        },
      });
    });

    const signals = createSignals(threadId);
    await context.store.set(signals.initializeIndexedDbEvents$, context.signal);

    await expect(
      context.store.set(signals.syncRemoteEvents$, context.signal),
    ).rejects.toThrow("cursor expired right after a cold start");
    expect(rowRequests).toStrictEqual([0]);
  });

  it("initializes from cached rows without touching the network", async () => {
    await setupAuthenticatedBootstrap();
    context.mocks.api(chatThreadEventsContract.snapshot, () => {
      throw new Error("snapshot endpoint must not be called");
    });
    const { threadId, promptEventRow, assistantEventRow } = threadFixture();
    await writeCachedRows([promptEventRow, assistantEventRow]);

    const signals = createSignals(threadId);
    await context.store.set(signals.initializeIndexedDbEvents$, context.signal);
    const events = context.store.get(signals.chatEvents$);
    expect(
      events.map((event) => {
        return event.id;
      }),
    ).toStrictEqual([promptEventRow.id, assistantEventRow.id]);
  });

  it("rebuilds from a fresh snapshot when the rows cursor expires", async () => {
    await setupAuthenticatedBootstrap();
    const { threadId, promptEventRow, assistantEventRow } = threadFixture();
    const appDb = await openTestChatDb();
    const staleRow = baseRow(threadId, 5);
    await writeCachedRows([staleRow]);

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(200, {
        url: SNAPSHOT_URL,
        expiresInSeconds: 900,
        lastEventId: assistantEventRow.id,
        lastSeqId: 2,
      });
    });
    context.mocks.http.get(SNAPSHOT_URL, () => {
      return new Response(snapshotNdjson([promptEventRow, assistantEventRow]));
    });
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      if (query.sinceSeqId === 5) {
        return respond(410, {
          error: {
            message: "Chat events cursor has expired",
            code: "CHAT_EVENTS_EXPIRED",
          },
        });
      }
      return respond(200, { rows: [] });
    });

    const signals = createSignals(threadId);
    await context.store.set(signals.initializeIndexedDbEvents$, context.signal);
    await context.store.set(signals.syncRemoteEvents$, context.signal);

    const eventIds = context.store.get(signals.chatEvents$).map((event) => {
      return event.id;
    });
    expect(eventIds).toContain(promptEventRow.id);
    expect(eventIds).toContain(assistantEventRow.id);

    await expect(
      appDb.get(CHAT_EVENT_ROWS_STORE, staleRow.id),
    ).resolves.toBeUndefined();
    await expect(
      appDb.get(CHAT_EVENT_ROWS_STORE, promptEventRow.id),
    ).resolves.toStrictEqual(promptEventRow);
  });

  it("background-syncs new rows into the row cache", async () => {
    await setupAuthenticatedBootstrap();
    const { threadId, promptEventRow, assistantEventRow, tailEventRow } =
      threadFixture();
    const appDb = await openTestChatDb();
    await writeCachedRows([promptEventRow, assistantEventRow]);
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      if (query.sinceSeqId === 2) {
        return respond(200, { rows: [tailEventRow] });
      }
      return respond(200, { rows: [] });
    });

    await context.store.set(setupRealtime$, context.signal);
    const subscriberSignal = context.store.set(
      resetSubscriberSignal$,
      context.signal,
    );
    const subscription = context.store.set(
      setupChatEventBackgroundSync$,
      subscriberSignal,
    );
    context.track(subscription);

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });

    context.mocks.ably.trigger(`chatThreadMessageCreated:${threadId}`);

    await waitFor(async () => {
      await expect(
        appDb.get(CHAT_EVENT_ROWS_STORE, tailEventRow.id),
      ).resolves.toStrictEqual(tailEventRow);
    });
  });

  it("background-cold-starts raw rows and forwards them to an active thread", async () => {
    await setupAuthenticatedBootstrap();
    const { threadId, promptEventRow, assistantEventRow, tailEventRow } =
      threadFixture();
    const appDb = await openTestChatDb();

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(200, {
        url: SNAPSHOT_URL,
        expiresInSeconds: 900,
        lastEventId: assistantEventRow.id,
        lastSeqId: assistantEventRow.seqId,
      });
    });
    context.mocks.http.get(SNAPSHOT_URL, () => {
      return new Response(snapshotNdjson([promptEventRow, assistantEventRow]));
    });
    const rowRequests: number[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      rowRequests.push(query.sinceSeqId);
      if (query.sinceSeqId === assistantEventRow.seqId) {
        return respond(200, { rows: [tailEventRow] });
      }
      return respond(200, { rows: [] });
    });

    const signals = createChatEventSignals(threadId);
    await context.store.set(signals.setup$, context.signal);
    await context.store.set(setupRealtime$, context.signal);
    const subscriberSignal = context.store.set(
      resetSubscriberSignal$,
      context.signal,
    );
    const subscription = context.store.set(
      setupChatEventBackgroundSync$,
      subscriberSignal,
    );
    context.track(subscription);

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });

    context.mocks.ably.trigger(`chatThreadMessageCreated:${threadId}`);

    await waitFor(() => {
      expect(
        context.store.get(signals.chatEvents$).map((event) => {
          return event.id;
        }),
      ).toStrictEqual([
        promptEventRow.id,
        assistantEventRow.id,
        tailEventRow.id,
      ]);
    });
    expect(rowRequests).toStrictEqual([assistantEventRow.seqId]);
    await expect(
      appDb.get(CHAT_EVENT_ROWS_STORE, tailEventRow.id),
    ).resolves.toStrictEqual(tailEventRow);
  });

  it("background-cold-starts from row zero when no snapshot exists", async () => {
    await setupAuthenticatedBootstrap();
    const { threadId, promptEventRow, assistantEventRow } = threadFixture();
    const appDb = await openTestChatDb();

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    const rowRequests: number[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      rowRequests.push(query.sinceSeqId);
      if (query.sinceSeqId === 0) {
        return respond(200, { rows: [promptEventRow, assistantEventRow] });
      }
      return respond(200, { rows: [] });
    });

    await context.store.set(setupRealtime$, context.signal);
    const subscriberSignal = context.store.set(
      resetSubscriberSignal$,
      context.signal,
    );
    const subscription = context.store.set(
      setupChatEventBackgroundSync$,
      subscriberSignal,
    );
    context.track(subscription);

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });

    context.mocks.ably.trigger(`chatThreadMessageCreated:${threadId}`);

    await waitFor(async () => {
      await expect(
        appDb.get(CHAT_EVENT_ROWS_STORE, assistantEventRow.id),
      ).resolves.toStrictEqual(assistantEventRow);
    });
    expect(rowRequests).toStrictEqual([0]);
  });

  it("background-rebuilds raw rows when the cached cursor expires", async () => {
    await setupAuthenticatedBootstrap();
    const { threadId, promptEventRow, assistantEventRow, tailEventRow } =
      threadFixture();
    const staleRow = baseRow(threadId, 5);
    const appDb = await openTestChatDb();
    await writeCachedRows([staleRow]);

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(200, {
        url: SNAPSHOT_URL,
        expiresInSeconds: 900,
        lastEventId: assistantEventRow.id,
        lastSeqId: assistantEventRow.seqId,
      });
    });
    context.mocks.http.get(SNAPSHOT_URL, () => {
      return new Response(snapshotNdjson([promptEventRow, assistantEventRow]));
    });
    const rowRequests: number[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      rowRequests.push(query.sinceSeqId);
      if (query.sinceSeqId === staleRow.seqId) {
        return respond(410, {
          error: {
            code: "CHAT_EVENTS_EXPIRED",
            message: "Chat events cursor has expired",
          },
        });
      }
      return respond(200, { rows: [tailEventRow] });
    });

    await context.store.set(setupRealtime$, context.signal);
    const subscriberSignal = context.store.set(
      resetSubscriberSignal$,
      context.signal,
    );
    const subscription = context.store.set(
      setupChatEventBackgroundSync$,
      subscriberSignal,
    );
    context.track(subscription);

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });

    context.mocks.ably.trigger(`chatThreadMessageCreated:${threadId}`);

    await waitFor(async () => {
      await expect(
        appDb.get(CHAT_EVENT_ROWS_STORE, tailEventRow.id),
      ).resolves.toStrictEqual(tailEventRow);
    });
    expect(rowRequests).toStrictEqual([
      staleRow.seqId,
      assistantEventRow.seqId,
    ]);
    await expect(
      appDb.get(CHAT_EVENT_ROWS_STORE, staleRow.id),
    ).resolves.toBeUndefined();
    await expect(
      appDb.get(CHAT_EVENT_ROWS_STORE, promptEventRow.id),
    ).resolves.toStrictEqual(promptEventRow);
  });
});
