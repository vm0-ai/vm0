import { waitFor } from "@testing-library/react";
import type { ChatEventRowV4 } from "@vm0/api-contracts/contracts/chat-event-rows";
import { chatThreadEventsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearMockedAuth,
  mockOrganization,
  mockUser,
} from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { CHAT_EVENT_ROWS_STORE } from "../../external/chat-idb-schema.ts";
import { chatIdb$ } from "../../external/chat-idb-store.ts";
import { setupRealtime$ } from "../../realtime.ts";
import { resetSignal } from "../../utils.ts";
import { setupChatEventBackgroundSync$ } from "../chat-event-background-sync.ts";
import { writeIndexedDbChatEventRows$ } from "../chat-event-row-indexed-db.ts";
import { createChatEventSignals } from "../chat-event-signals.ts";
import { createChatEventStorageSignals } from "../chat-event-storage-signals.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();
const resetSubscriberSignal$ = resetSignal();

const SNAPSHOT_URL = "https://r2.example.com/chat-events/snapshot.ndjson.gz";
const CREATED_AT = "2026-08-08T10:00:00.000Z";

function baseRow(threadId: string, seqId: number): ChatEventRowV4 {
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
): ChatEventRowV4 {
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

interface ThreadFixture {
  readonly threadId: string;
  readonly promptEventRow: ChatEventRowV4;
  readonly assistantEventRow: ChatEventRowV4;
  readonly tailEventRow: ChatEventRowV4;
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

function snapshotNdjson(rows: readonly ChatEventRowV4[]): string {
  return `${rows
    .map((row) => {
      return JSON.stringify(row);
    })
    .join("\n")}\n`;
}

function createSignals(threadId: string) {
  return createChatEventStorageSignals({ threadId });
}

function mockSignedInUser(): void {
  mockUser(
    {
      id: "snapshot-read-user",
      fullName: "Snapshot Read User",
      email: "snapshot-read@example.com",
    },
    { token: "test-token" },
  );
  mockOrganization({
    activeOrg: { id: "snapshot-read-org", name: "Snapshot Read Org" },
    memberships: [{ id: "snapshot-read-org" }],
  });
}

describe("chat event snapshot read", () => {
  afterEach(() => {
    clearMockedAuth();
  });

  it("tails from snapshot coverage beyond the final archive row", async () => {
    mockSignedInUser();
    const { threadId, promptEventRow, assistantEventRow } = threadFixture();
    const tailEventRow = baseRow(threadId, 4);
    const appDb = await context.store.get(chatIdb$);

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(200, {
        url: SNAPSHOT_URL,
        expiresInSeconds: 900,
        lastSeqId: 3,
      });
    });
    context.mocks.http.get(SNAPSHOT_URL, () => {
      return new Response(snapshotNdjson([promptEventRow, assistantEventRow]));
    });
    const rowRequests: number[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      rowRequests.push(query.sinceSeqId);
      if (query.sinceSeqId === 3) {
        return respond(200, { rows: [tailEventRow] });
      }
      return respond(200, { rows: [] });
    });

    const signals = createSignals(threadId);
    try {
      await context.store.set(
        signals.initializeIndexedDbEvents$,
        context.signal,
      );
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
        { id: promptEventRow.id, seqId: 1, eventType: "input.prompt" },
        { id: assistantEventRow.id, seqId: 2, eventType: "output.message" },
        { id: tailEventRow.id, seqId: 4, eventType: "output.message" },
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
      expect(rowRequests).toStrictEqual([3, 4]);

      await expect(
        appDb.get(CHAT_EVENT_ROWS_STORE, tailEventRow.id),
      ).resolves.toStrictEqual(tailEventRow);
    } finally {
      appDb.close();
    }
  });

  it("cold-starts from the rows endpoint when the thread has no snapshot yet", async () => {
    mockSignedInUser();
    const { threadId, promptEventRow, assistantEventRow } = threadFixture();
    const appDb = await context.store.get(chatIdb$);

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
    try {
      await context.store.set(
        signals.initializeIndexedDbEvents$,
        context.signal,
      );
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
    } finally {
      appDb.close();
    }
  });

  it("fails loudly when the rows cursor expires right after a cold start", async () => {
    mockSignedInUser();
    const { threadId } = threadFixture();
    const appDb = await context.store.get(chatIdb$);

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
    try {
      await context.store.set(
        signals.initializeIndexedDbEvents$,
        context.signal,
      );

      await expect(
        context.store.set(signals.syncRemoteEvents$, context.signal),
      ).rejects.toThrow("cursor expired right after a cold start");
      expect(rowRequests).toStrictEqual([0]);
    } finally {
      appDb.close();
    }
  });

  it("initializes from cached rows without touching the network", async () => {
    mockSignedInUser();
    context.mocks.api(chatThreadEventsContract.snapshot, () => {
      throw new Error("snapshot endpoint must not be called");
    });
    const { threadId, promptEventRow, assistantEventRow } = threadFixture();
    const appDb = await context.store.get(chatIdb$);
    await context.store.set(
      writeIndexedDbChatEventRows$,
      [promptEventRow, assistantEventRow],
      context.signal,
    );

    const signals = createSignals(threadId);
    try {
      await context.store.set(
        signals.initializeIndexedDbEvents$,
        context.signal,
      );
      const events = context.store.get(signals.chatEvents$);
      expect(
        events.map((event) => {
          return event.id;
        }),
      ).toStrictEqual([promptEventRow.id, assistantEventRow.id]);
    } finally {
      appDb.close();
    }
  });

  it("rebuilds from a fresh snapshot when the rows cursor expires", async () => {
    mockSignedInUser();
    const { threadId, promptEventRow, assistantEventRow } = threadFixture();
    const appDb = await context.store.get(chatIdb$);
    const staleRow = baseRow(threadId, 5);
    await context.store.set(
      writeIndexedDbChatEventRows$,
      [staleRow],
      context.signal,
    );

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(200, {
        url: SNAPSHOT_URL,
        expiresInSeconds: 900,
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
    try {
      await context.store.set(
        signals.initializeIndexedDbEvents$,
        context.signal,
      );
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
    } finally {
      appDb.close();
    }
  });

  it("background-syncs new rows into the row cache", async () => {
    mockSignedInUser();
    const { threadId, promptEventRow, assistantEventRow, tailEventRow } =
      threadFixture();
    const appDb = await context.store.get(chatIdb$);
    await context.store.set(
      writeIndexedDbChatEventRows$,
      [promptEventRow, assistantEventRow],
      context.signal,
    );
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

    try {
      await waitFor(() => {
        expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
      });

      context.mocks.ably.trigger(`chatThreadMessageCreated:${threadId}`);

      await waitFor(async () => {
        await expect(
          appDb.get(CHAT_EVENT_ROWS_STORE, tailEventRow.id),
        ).resolves.toStrictEqual(tailEventRow);
      });
    } finally {
      context.store.set(resetSubscriberSignal$, context.signal);
      await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
      appDb.close();
    }
  });

  it("background-cold-starts raw rows and forwards them to an active thread", async () => {
    mockSignedInUser();
    const { threadId, promptEventRow, assistantEventRow, tailEventRow } =
      threadFixture();
    const appDb = await context.store.get(chatIdb$);

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(200, {
        url: SNAPSHOT_URL,
        expiresInSeconds: 900,
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

    try {
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
    } finally {
      context.store.set(resetSubscriberSignal$, context.signal);
      await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
      appDb.close();
    }
  });

  it("background-cold-starts from row zero when no snapshot exists", async () => {
    mockSignedInUser();
    const { threadId, promptEventRow, assistantEventRow } = threadFixture();
    const appDb = await context.store.get(chatIdb$);

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

    try {
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
    } finally {
      context.store.set(resetSubscriberSignal$, context.signal);
      await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
      appDb.close();
    }
  });

  it("background-rebuilds raw rows when the cached cursor expires", async () => {
    mockSignedInUser();
    const { threadId, promptEventRow, assistantEventRow, tailEventRow } =
      threadFixture();
    const staleRow = baseRow(threadId, 5);
    const appDb = await context.store.get(chatIdb$);
    await context.store.set(
      writeIndexedDbChatEventRows$,
      [staleRow],
      context.signal,
    );

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(200, {
        url: SNAPSHOT_URL,
        expiresInSeconds: 900,
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

    try {
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
    } finally {
      context.store.set(resetSubscriberSignal$, context.signal);
      await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
      appDb.close();
    }
  });
});
