import { randomUUID } from "node:crypto";

import { testChatEventRetentionContract } from "@okouai/api-contracts/contracts/test-chat-event-retention";
import { cronRetainChatEventsContract } from "@okouai/api-contracts/contracts/cron";
import { createStore } from "ccstate";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  coverRetentionThread$,
  failRetentionToolCleanupAfterMutation$,
  holdChatEventRetentionLockFixture,
  holdRetentionToolWriterFixture,
  openRetentionActiveInput$,
  readRetentionEvents$,
  readRetentionSnapshotHeads$,
  revokeRetentionEvent$,
  seedRetentionOutputEvent$,
  seedRetentionOutputEvents$,
  seedRetentionPendingEvent$,
  seedRetentionRun$,
  seedRetentionToolEvent$,
  setRetentionRunStatus$,
  settleRetentionActiveInput$,
} from "../../../test-fixtures/chat-event-retention";
import { cronRetainChatEventsRoutes } from "../cron-retain-chat-events";
import { testChatEventRetentionRoutes } from "../test-chat-event-retention";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const CRON_SECRET = "test-chat-event-retention-secret";
const DEPLOYMENT_SHA = "a".repeat(40);
const OLD_OFFSET_MS = -60_000;
const NEW_OFFSET_MS = 60_000;

function fixtureClient() {
  return setupApp({ context, routes: testChatEventRetentionRoutes })(
    testChatEventRetentionContract,
  );
}

function cronClient() {
  return setupApp({ context, routes: cronRetainChatEventsRoutes })(
    cronRetainChatEventsContract,
  );
}

async function createFixtureThread(label: string): Promise<string> {
  const actor = bdd.user({ orgId: `org_${randomUUID()}` });
  const agent = await bdd.createAgent(actor, {
    displayName: `${label} retention agent`,
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: `${label} retention thread`,
  });
  return thread.id;
}

async function retainFixtures(...chatThreadIds: readonly string[]) {
  return await retainFixtureBatch({ chatThreadIds });
}

async function retainFixtureBatch(args: {
  readonly chatThreadIds: readonly string[];
  readonly toolCleanupThreadScanLimit?: number;
  readonly toolCleanupDeleteLimit?: number;
}) {
  const response = await accept(
    fixtureClient().retain({
      body: {
        chat_thread_ids: [...args.chatThreadIds],
        ...(args.toolCleanupThreadScanLimit === undefined
          ? {}
          : {
              tool_cleanup_thread_scan_limit: args.toolCleanupThreadScanLimit,
            }),
        ...(args.toolCleanupDeleteLimit === undefined
          ? {}
          : { tool_cleanup_delete_limit: args.toolCleanupDeleteLimit }),
      },
    }),
    [200],
  );
  return response.body;
}

async function eventRows(...eventIds: readonly string[]) {
  return await store.set(readRetentionEvents$, eventIds, context.signal);
}

async function snapshotHeads(chatThreadId: string) {
  return await store.set(
    readRetentionSnapshotHeads$,
    chatThreadId,
    context.signal,
  );
}

function retentionCompletionEvents(): readonly Record<string, unknown>[] {
  return context.mocks.axiom.ingest.mock.calls.flatMap(([dataset, events]) => {
    if (dataset !== "web-logs" || !Array.isArray(events)) {
      return [];
    }
    return events.filter((event): event is Record<string, unknown> => {
      return (
        typeof event === "object" &&
        event !== null &&
        event.type === "chat_event_retention_completed"
      );
    });
  });
}

describe("chat event retention cron", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("GIT_COMMIT_SHA", DEPLOYMENT_SHA);
  });

  it("requires the cron secret", async () => {
    const response = await accept(cronClient().retain({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("uses one fixed database cutoff and never deletes a row at or newer than it", async () => {
    const threadId = await createFixtureThread("boundary");
    const oldEventId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: threadId, offsetMs: OLD_OFFSET_MS },
      context.signal,
    );
    const batchEventIds = await store.set(
      seedRetentionOutputEvents$,
      { chatThreadId: threadId, count: 2500, offsetMs: OLD_OFFSET_MS },
      context.signal,
    );
    const oldEventIds = [oldEventId, ...batchEventIds];
    const retainedEventId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: threadId, offsetMs: NEW_OFFSET_MS },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      { chatThreadId: threadId },
      context.signal,
    );
    const before = await eventRows(oldEventId, retainedEventId);

    const result = await retainFixtures(threadId);
    const cutoff = new Date(result.cutoff);

    expect(result).toMatchObject({
      scanLimit: 5000,
      deleteLimit: 2500,
      candidates: 2501,
      deleted: 2500,
      skippedBatchLimit: 1,
      overlapPrevented: false,
      hasMore: true,
    });
    expect(
      before
        .find((row) => {
          return row.id === oldEventId;
        })
        ?.createdAt.getTime(),
    ).toBeLessThan(cutoff.getTime());
    expect(
      before
        .find((row) => {
          return row.id === retainedEventId;
        })
        ?.createdAt.getTime(),
    ).toBeGreaterThanOrEqual(cutoff.getTime());
    const retainedAfterFirstBatch = await eventRows(
      ...oldEventIds,
      retainedEventId,
    );
    expect(
      retainedAfterFirstBatch.filter((row) => {
        return oldEventIds.includes(row.id);
      }),
    ).toHaveLength(1);
    expect(retainedAfterFirstBatch).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: retainedEventId,
          revokesEventId: null,
        }),
      ]),
    );

    const completionEvents = retentionCompletionEvents();
    expect(completionEvents).toHaveLength(1);
    expect(completionEvents[0]).toMatchObject({
      type: "chat_event_retention_completed",
      context: "api:cron:retain-chat-events",
      deploymentCommitSha: DEPLOYMENT_SHA,
      cutoff: result.cutoff,
      scanLimit: 5000,
      scanned: result.scanned,
      candidates: 2501,
      deleted: 2500,
      skippedSnapshot: 0,
      skippedSearchWatermark: 0,
      skippedPendingRunless: 0,
      skippedNonterminalRun: 0,
      skippedActiveInput: 0,
      skippedBatchLimit: 1,
      toolCleanupRowsDeleted: 0,
      toolCleanupFullPointersRetired: 1,
      toolCleanupRemainingRows: 0,
      toolCleanupRemainingFullPointers: 0,
      toolCleanupHasMore: false,
      hasMore: true,
    });

    const retry = await retainFixtures(threadId);
    expect(retry).toMatchObject({ deleted: 1, candidates: 1, hasMore: false });
    const finalRetry = await retainFixtures(threadId);
    expect(finalRetry).toMatchObject({
      deleted: 0,
      candidates: 0,
      hasMore: false,
    });
    await expect(eventRows(...oldEventIds)).resolves.toHaveLength(0);
    await expect(eventRows(retainedEventId)).resolves.toHaveLength(1);
  }, 60_000);

  it("uses a clean redacted head as retention authority", async () => {
    const snapshotThreadId = await createFixtureThread("snapshot-gate");
    const searchThreadId = await createFixtureThread("search-gate");
    const projectionThreadId = await createFixtureThread("projection-gate");
    const redactedAuthorityThreadId =
      await createFixtureThread("redacted-authority");
    const snapshotEventId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: snapshotThreadId, offsetMs: OLD_OFFSET_MS },
      context.signal,
    );
    const searchEventId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: searchThreadId, offsetMs: OLD_OFFSET_MS },
      context.signal,
    );
    const projectionEventId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: projectionThreadId, offsetMs: OLD_OFFSET_MS },
      context.signal,
    );
    const redactedAuthorityEventId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: redactedAuthorityThreadId, offsetMs: OLD_OFFSET_MS },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      { chatThreadId: snapshotThreadId, archiveSchemaVersion: 3 },
      context.signal,
    );
    const searchLastSeqId = await store.set(
      coverRetentionThread$,
      { chatThreadId: searchThreadId },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      {
        chatThreadId: searchThreadId,
        indexedSeqId: searchLastSeqId - 1,
      },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      {
        chatThreadId: projectionThreadId,
        snapshotProjections: ["full"],
      },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      {
        chatThreadId: redactedAuthorityThreadId,
        snapshotProjections: ["tool-redacted"],
      },
      context.signal,
    );

    const held = await retainFixtures(
      snapshotThreadId,
      searchThreadId,
      projectionThreadId,
      redactedAuthorityThreadId,
    );
    expect(held).toMatchObject({
      deleted: 1,
      skippedSnapshot: 2,
      skippedSearchWatermark: 1,
    });
    await expect(
      eventRows(
        snapshotEventId,
        searchEventId,
        projectionEventId,
        redactedAuthorityEventId,
      ),
    ).resolves.toHaveLength(3);

    await store.set(
      coverRetentionThread$,
      { chatThreadId: snapshotThreadId },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      { chatThreadId: searchThreadId },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      { chatThreadId: projectionThreadId },
      context.signal,
    );
    const released = await retainFixtures(
      snapshotThreadId,
      searchThreadId,
      projectionThreadId,
    );
    expect(released.deleted).toBe(3);
    await expect(
      eventRows(snapshotEventId, searchEventId, projectionEventId),
    ).resolves.toHaveLength(0);
  }, 60_000);

  it("cleans only tool threads covered by the durable redacted physical head", async () => {
    const coveredThreadId = await createFixtureThread("covered-tool");
    const blockedThreadId = await createFixtureThread("stale-tool-tail");
    const missingHeadThreadId = await createFixtureThread(
      "missing-redacted-head",
    );

    const coveredToolId = await store.set(
      seedRetentionToolEvent$,
      { chatThreadId: coveredThreadId },
      context.signal,
    );
    const coveredSeqId = await store.set(
      coverRetentionThread$,
      { chatThreadId: coveredThreadId },
      context.signal,
    );
    const safeTailId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: coveredThreadId },
      context.signal,
    );

    const blockedFirstToolId = await store.set(
      seedRetentionToolEvent$,
      { chatThreadId: blockedThreadId },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      { chatThreadId: blockedThreadId },
      context.signal,
    );
    const blockedTailToolId = await store.set(
      seedRetentionToolEvent$,
      { chatThreadId: blockedThreadId },
      context.signal,
    );

    const missingHeadToolId = await store.set(
      seedRetentionToolEvent$,
      { chatThreadId: missingHeadThreadId },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      {
        chatThreadId: missingHeadThreadId,
        snapshotProjections: ["full"],
      },
      context.signal,
    );

    const partial = await retainFixtures(
      coveredThreadId,
      blockedThreadId,
      missingHeadThreadId,
    );
    expect(partial).toMatchObject({
      toolCleanupToolThreadsScanned: 3,
      toolCleanupToolThreadsCovered: 1,
      toolCleanupToolThreadsBlockedMissingRedactedHead: 1,
      toolCleanupToolThreadsBlockedRedactedCoverage: 1,
      toolCleanupRowsSelected: 1,
      toolCleanupRowsDeleted: 1,
      toolCleanupFullPointersCovered: 1,
      toolCleanupFullPointersRetired: 1,
      toolCleanupRemainingRows: 3,
      toolCleanupRemainingFullPointers: 2,
      toolCleanupHasMore: true,
    });
    await expect(eventRows(coveredToolId)).resolves.toHaveLength(0);
    await expect(eventRows(safeTailId)).resolves.toMatchObject([
      {
        eventType: "output.message",
        id: safeTailId,
        seqId: coveredSeqId + 1,
      },
    ]);
    await expect(
      eventRows(blockedFirstToolId, blockedTailToolId, missingHeadToolId),
    ).resolves.toHaveLength(3);
    await expect(snapshotHeads(coveredThreadId)).resolves.toMatchObject([
      { lastSeqId: coveredSeqId, projection: "tool-redacted" },
    ]);

    await store.set(
      coverRetentionThread$,
      {
        chatThreadId: blockedThreadId,
        snapshotProjections: ["tool-redacted"],
      },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      {
        chatThreadId: missingHeadThreadId,
        snapshotProjections: ["tool-redacted"],
      },
      context.signal,
    );

    const resumed = await retainFixtures(
      coveredThreadId,
      blockedThreadId,
      missingHeadThreadId,
    );
    expect(resumed).toMatchObject({
      toolCleanupRowsDeleted: 3,
      toolCleanupFullPointersRetired: 2,
      toolCleanupRemainingRows: 0,
      toolCleanupRemainingFullPointers: 0,
      toolCleanupHasMore: false,
    });
    await expect(
      eventRows(blockedFirstToolId, blockedTailToolId, missingHeadToolId),
    ).resolves.toHaveLength(0);
    await expect(snapshotHeads(blockedThreadId)).resolves.toMatchObject([
      { projection: "tool-redacted" },
    ]);
    await expect(snapshotHeads(missingHeadThreadId)).resolves.toMatchObject([
      { projection: "tool-redacted" },
    ]);

    const idempotent = await retainFixtures(
      coveredThreadId,
      blockedThreadId,
      missingHeadThreadId,
    );
    expect(idempotent).toMatchObject({
      toolCleanupThreadsScanned: 0,
      toolCleanupRowsDeleted: 0,
      toolCleanupFullPointersRetired: 0,
      toolCleanupRemainingRows: 0,
      toolCleanupRemainingFullPointers: 0,
      toolCleanupHasMore: false,
    });
  }, 60_000);

  it("resumes tool cleanup across bounded thread and row batches", async () => {
    const firstThreadId = await createFixtureThread("bounded-tool-first");
    const secondThreadId = await createFixtureThread("bounded-tool-second");
    const firstToolId = await store.set(
      seedRetentionToolEvent$,
      { chatThreadId: firstThreadId },
      context.signal,
    );
    const secondToolId = await store.set(
      seedRetentionToolEvent$,
      { chatThreadId: secondThreadId },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      { chatThreadId: firstThreadId },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      { chatThreadId: secondThreadId },
      context.signal,
    );

    const firstBatch = await retainFixtureBatch({
      chatThreadIds: [firstThreadId, secondThreadId],
      toolCleanupThreadScanLimit: 1,
      toolCleanupDeleteLimit: 1,
    });
    expect(firstBatch).toMatchObject({
      toolCleanupThreadScanLimit: 1,
      toolCleanupDeleteLimit: 1,
      toolCleanupThreadsScanned: 1,
      toolCleanupRowsDeleted: 1,
      toolCleanupFullPointersRetired: 1,
      toolCleanupRemainingRows: 1,
      toolCleanupRemainingFullPointers: 1,
      toolCleanupHasMore: true,
    });
    await expect(eventRows(firstToolId, secondToolId)).resolves.toHaveLength(1);

    const resumed = await retainFixtureBatch({
      chatThreadIds: [firstThreadId, secondThreadId],
      toolCleanupThreadScanLimit: 1,
      toolCleanupDeleteLimit: 1,
    });
    expect(resumed).toMatchObject({
      toolCleanupThreadsScanned: 1,
      toolCleanupRowsDeleted: 1,
      toolCleanupFullPointersRetired: 1,
      toolCleanupRemainingRows: 0,
      toolCleanupRemainingFullPointers: 0,
      toolCleanupHasMore: false,
    });
    await expect(eventRows(firstToolId, secondToolId)).resolves.toHaveLength(0);

    const finalRetry = await retainFixtureBatch({
      chatThreadIds: [firstThreadId, secondThreadId],
      toolCleanupThreadScanLimit: 1,
      toolCleanupDeleteLimit: 1,
    });
    expect(finalRetry).toMatchObject({
      toolCleanupThreadsScanned: 0,
      toolCleanupRowsDeleted: 0,
      toolCleanupFullPointersRetired: 0,
      toolCleanupHasMore: false,
    });
  }, 60_000);

  it("rolls back a partial cleanup failure and resumes on restart", async () => {
    const threadId = await createFixtureThread("tool-cleanup-restart");
    const toolId = await store.set(
      seedRetentionToolEvent$,
      { chatThreadId: threadId },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      { chatThreadId: threadId },
      context.signal,
    );

    await expect(
      store.set(
        failRetentionToolCleanupAfterMutation$,
        [threadId],
        context.signal,
      ),
    ).rejects.toThrow("Injected failure after tool cleanup mutation");
    await expect(eventRows(toolId)).resolves.toHaveLength(1);
    await expect(snapshotHeads(threadId)).resolves.toHaveLength(2);

    const restarted = await retainFixtures(threadId);
    expect(restarted).toMatchObject({
      toolCleanupRowsDeleted: 1,
      toolCleanupFullPointersRetired: 1,
      toolCleanupRemainingRows: 0,
      toolCleanupRemainingFullPointers: 0,
      toolCleanupHasMore: false,
    });
    await expect(eventRows(toolId)).resolves.toHaveLength(0);
    await expect(snapshotHeads(threadId)).resolves.toMatchObject([
      { projection: "tool-redacted" },
    ]);
  }, 60_000);

  it("skips a stale writer and rechecks its committed physical tail", async () => {
    const threadId = await createFixtureThread("stale-tool-writer");
    const coveredToolId = await store.set(
      seedRetentionToolEvent$,
      { chatThreadId: threadId },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      { chatThreadId: threadId },
      context.signal,
    );
    const writer = await holdRetentionToolWriterFixture(
      threadId,
      context.signal,
    );
    onTestFinished(async () => {
      writer.release();
      await writer.done;
    });

    const skipped = await retainFixtures(threadId);
    expect(skipped).toMatchObject({
      toolCleanupThreadsScanned: 0,
      toolCleanupRowsDeleted: 0,
      toolCleanupFullPointersRetired: 0,
      toolCleanupRemainingRows: 1,
      toolCleanupRemainingFullPointers: 1,
      toolCleanupHasMore: true,
    });
    await expect(eventRows(coveredToolId)).resolves.toHaveLength(1);
    await expect(snapshotHeads(threadId)).resolves.toHaveLength(2);

    writer.release();
    const staleTailToolId = await writer.done;
    const blocked = await retainFixtures(threadId);
    expect(blocked).toMatchObject({
      toolCleanupThreadsScanned: 1,
      toolCleanupToolThreadsBlockedRedactedCoverage: 1,
      toolCleanupRowsDeleted: 0,
      toolCleanupFullPointersRetired: 0,
      toolCleanupRemainingRows: 2,
      toolCleanupRemainingFullPointers: 1,
      toolCleanupHasMore: true,
    });
    await expect(
      eventRows(coveredToolId, staleTailToolId),
    ).resolves.toHaveLength(2);

    await store.set(
      coverRetentionThread$,
      {
        chatThreadId: threadId,
        snapshotProjections: ["tool-redacted"],
      },
      context.signal,
    );
    const covered = await retainFixtures(threadId);
    expect(covered).toMatchObject({
      toolCleanupRowsDeleted: 2,
      toolCleanupFullPointersRetired: 1,
      toolCleanupRemainingRows: 0,
      toolCleanupRemainingFullPointers: 0,
      toolCleanupHasMore: false,
    });
    await expect(
      eventRows(coveredToolId, staleTailToolId),
    ).resolves.toHaveLength(0);
  }, 60_000);

  it("holds pending runless, nonterminal-run, and open active-input evidence", async () => {
    const threadId = await createFixtureThread("live-state-gates");
    const pendingEventId = await store.set(
      seedRetentionPendingEvent$,
      { chatThreadId: threadId, offsetMs: -120_000 },
      context.signal,
    );
    const runningRunId = await store.set(
      seedRetentionRun$,
      { chatThreadId: threadId, status: "running" },
      context.signal,
    );
    const runningEventId = await store.set(
      seedRetentionOutputEvent$,
      {
        chatThreadId: threadId,
        runId: runningRunId,
        offsetMs: OLD_OFFSET_MS,
      },
      context.signal,
    );
    const activeRunId = await store.set(
      seedRetentionRun$,
      { chatThreadId: threadId, status: "completed" },
      context.signal,
    );
    const activeEventId = await store.set(
      seedRetentionOutputEvent$,
      {
        chatThreadId: threadId,
        runId: activeRunId,
        offsetMs: OLD_OFFSET_MS,
      },
      context.signal,
    );
    await store.set(
      openRetentionActiveInput$,
      {
        chatThreadId: threadId,
        runId: activeRunId,
        sourceEventId: activeEventId,
      },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      { chatThreadId: threadId },
      context.signal,
    );

    const held = await retainFixtures(threadId);
    expect(held).toMatchObject({
      deleted: 0,
      skippedPendingRunless: 1,
      skippedNonterminalRun: 1,
      skippedActiveInput: 1,
    });
    await expect(
      eventRows(pendingEventId, runningEventId, activeEventId),
    ).resolves.toHaveLength(3);

    const pendingRevokerId = await store.set(
      revokeRetentionEvent$,
      {
        chatThreadId: threadId,
        eventId: pendingEventId,
        offsetMs: OLD_OFFSET_MS,
      },
      context.signal,
    );
    await store.set(
      setRetentionRunStatus$,
      { runId: runningRunId, status: "completed" },
      context.signal,
    );
    await store.set(settleRetentionActiveInput$, activeEventId, context.signal);
    await store.set(
      coverRetentionThread$,
      { chatThreadId: threadId },
      context.signal,
    );

    const released = await retainFixtures(threadId);
    expect(released.deleted).toBe(4);
    await expect(
      eventRows(
        pendingEventId,
        pendingRevokerId,
        runningEventId,
        activeEventId,
      ),
    ).resolves.toHaveLength(0);
  }, 60_000);

  it("prevents overlapping retention transactions without waiting", async () => {
    const threadId = await createFixtureThread("overlap");
    const eventId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: threadId, offsetMs: OLD_OFFSET_MS },
      context.signal,
    );
    await store.set(
      coverRetentionThread$,
      { chatThreadId: threadId },
      context.signal,
    );
    const lock = await holdChatEventRetentionLockFixture(context.signal);
    onTestFinished(async () => {
      lock.release();
      await lock.done;
    });

    const overlapped = await retainFixtures(threadId);
    expect(overlapped).toMatchObject({
      overlapPrevented: true,
      scanned: 0,
      candidates: 0,
      deleted: 0,
    });
    await expect(eventRows(eventId)).resolves.toHaveLength(1);

    lock.release();
    await lock.done;
    const released = await retainFixtures(threadId);
    expect(released).toMatchObject({ overlapPrevented: false, deleted: 1 });
  }, 60_000);
});
