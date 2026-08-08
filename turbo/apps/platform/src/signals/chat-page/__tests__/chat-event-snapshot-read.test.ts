import { waitFor } from "@testing-library/react";
import type { ChatEventRow } from "@vm0/api-contracts/contracts/chat-event-rows";
import { chatThreadEventsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearMockedAuth,
  mockOrganization,
  mockUser,
} from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  CHAT_EVENT_ROWS_STORE,
  CHAT_MESSAGES_STORE,
} from "../../external/chat-idb-schema.ts";
import { chatIdb$ } from "../../external/chat-idb-store.ts";
import { FEATURE_SWITCH_CACHE_KEY } from "../../external/feature-switch.ts";
import { localStorageSignals } from "../../external/local-storage.ts";
import { setupRealtime$ } from "../../realtime.ts";
import { resetSignal } from "../../utils.ts";
import { setupChatEventBackgroundSync$ } from "../chat-event-background-sync.ts";
import { writeIndexedDbChatEventRows$ } from "../chat-event-row-indexed-db.ts";
import { createChatEventStorageSignals } from "../chat-event-storage-signals.ts";
import {
  listEventsAfter$,
  listEventsBefore$,
} from "../remote-chat-event-data-source.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();
const resetSubscriberSignal$ = resetSignal();

const SNAPSHOT_URL = "https://r2.example.com/chat-events/snapshot.ndjson.gz";
const CREATED_AT = "2026-08-08T10:00:00.000Z";

const { set$: setFeatureSwitchCache$ } = localStorageSignals(
  FEATURE_SWITCH_CACHE_KEY,
);

function enableSnapshotRead(): void {
  context.store.set(
    setFeatureSwitchCache$,
    JSON.stringify({
      ...getAllFeatureStates({}),
      [FeatureSwitchKey.ChatEventSnapshotRead]: true,
    }),
  );
}

function baseRow(threadId: string, seqId: number): ChatEventRow {
  return {
    id: crypto.randomUUID(),
    chatThreadId: threadId,
    runId: null,
    usagePayload: null,
    revokesEventId: null,
    interruptsRunId: null,
    runGroupId: null,
    eventType: "output.message",
    contextType: null,
    contextId: null,
    content: `message ${seqId}`,
    userMessage: null,
    thinking: null,
    error: null,
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
    content: null,
    userMessage: {
      version: 1,
      parts: [{ type: "text", text }],
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

function rejectLegacyEventsEndpoint(): void {
  context.mocks.api(chatThreadEventsContract.list, () => {
    throw new Error("legacy events endpoint must not be called");
  });
}

function createSignals(threadId: string) {
  return createChatEventStorageSignals({
    threadId,
    dataSource: { listEventsAfter$, listEventsBefore$ },
  });
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

  it("cold-starts from the snapshot object and tails the rows endpoint", async () => {
    mockSignedInUser();
    enableSnapshotRead();
    rejectLegacyEventsEndpoint();
    const { threadId, promptEventRow, assistantEventRow, tailEventRow } =
      threadFixture();
    const appDb = await context.store.get(chatIdb$);

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
    const rowRequests: number[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      rowRequests.push(query.sinceSeqId);
      if (query.sinceSeqId === 2) {
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
        { id: tailEventRow.id, seqId: 3, eventType: "output.message" },
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
      expect(
        context.store.get(signals.initialRemoteEventsResolved$),
      ).toBeTruthy();
      expect(rowRequests).toStrictEqual([2]);

      await expect(
        appDb.get(CHAT_EVENT_ROWS_STORE, tailEventRow.id),
      ).resolves.toStrictEqual(tailEventRow);
      await expect(
        appDb.get(CHAT_MESSAGES_STORE, tailEventRow.id),
      ).resolves.toBeUndefined();
    } finally {
      appDb.close();
    }
  });

  it("initializes from cached rows without touching the network", async () => {
    mockSignedInUser();
    enableSnapshotRead();
    rejectLegacyEventsEndpoint();
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
    enableSnapshotRead();
    rejectLegacyEventsEndpoint();
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
    enableSnapshotRead();
    rejectLegacyEventsEndpoint();
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
});
