import { randomUUID } from "node:crypto";

import { cronProjectChatEventSearchContract } from "@okouai/api-contracts/contracts/cron";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  insertChatSearchProjectionCoverageFixture,
  insertSearchablePromptFixture,
  readChatEventSearchProjectionFixture,
  rejectSearchablePromptFixture,
} from "../../../test-fixtures/chat-event-search";
import {
  holdChatEventInsertTransactionFixture,
  holdChatThreadDeleteTransactionFixture,
} from "../../../test-fixtures/chat-events";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const CRON_SECRET = "durable-chat-search-projection-secret";

async function projectChatEventSearch() {
  mockEnv("CRON_SECRET", CRON_SECRET);
  const client = setupApp({
    context,
    routes: cronProjectChatEventSearchRoutes,
  })(cronProjectChatEventSearchContract);
  const response = await accept(
    client.project({
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
    [200],
  );
  return response.body;
}

async function projectOwnedChatEventSearch(chatThreadIds: readonly string[]) {
  const client = setupApp({
    context,
    routes: testChatEventSearchProjectionRoutes,
  })(testChatEventSearchProjectionContract);
  const response = await accept(
    client.project({ body: { chat_thread_ids: [...chatThreadIds] } }),
    [200],
  );
  return response.body;
}

async function createProjectionThread(): Promise<string> {
  const actor = bdd.user();
  const agent = await chat.createAgentForChatThread(actor);
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: `Projection ${randomUUID()}`,
  });
  return thread.id;
}

describe("GET /api/cron/project-chat-event-search", () => {
  it("projects only non-empty visible user and assistant messages", async () => {
    const chatThreadId = await createProjectionThread();
    const promptText = `durable prompt ${randomUUID()}`;
    const assistantText = `durable assistant ${randomUUID()}`;
    const errorText = `excluded error ${randomUUID()}`;
    const terminalText = `excluded terminal ${randomUUID()}`;
    const { assistantRunId } = await insertChatSearchProjectionCoverageFixture({
      chatThreadId,
      promptText,
      assistantText,
      errorText,
      terminalText,
    });

    const tick = await projectOwnedChatEventSearch([chatThreadId]);
    expect(tick.success).toBeTruthy();
    expect(tick.threads).toBe(1);
    expect(tick.indexedEvents).toBe(2);
    expect(tick.convergence.eligibleThreads).toBe(1);
    expect(tick.convergence.durableCaughtUpThreads).toBe(1);

    const projection = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(projection.messages).toStrictEqual([
      {
        seqId: expect.any(Number),
        runId: null,
        role: "user",
        text: promptText,
      },
      {
        seqId: expect.any(Number),
        runId: assistantRunId,
        role: "assistant",
        text: assistantText,
      },
    ]);
    expect(projection.indexedSeqId).toBe(projection.lastChatEventSeqId);
  });

  it("authorizes the cron route and bounds its tick to the thread batch", async () => {
    // The cron route projects every lagging thread in the database, so this
    // shared-database test must cap the batch instead of scaling with the
    // threads that unrelated test files leave behind.
    mockOptionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE", "1");
    const tick = await projectChatEventSearch();

    expect(tick.success).toBeTruthy();
    expect(tick.threads).toBeLessThanOrEqual(1);
    expect(tick.convergence.eligibleThreads).toBeGreaterThanOrEqual(
      tick.convergence.durableCaughtUpThreads,
    );
  });

  it("keeps overlapping projection ticks idempotent", async () => {
    const chatThreadId = await createProjectionThread();
    const assistantText = `overlap assistant ${randomUUID()}`;
    await insertChatSearchProjectionCoverageFixture({
      chatThreadId,
      promptText: `overlap prompt ${randomUUID()}`,
      assistantText,
      errorText: `overlap error ${randomUUID()}`,
      terminalText: `overlap terminal ${randomUUID()}`,
    });

    const ticks = await Promise.all([
      projectOwnedChatEventSearch([chatThreadId]),
      projectOwnedChatEventSearch([chatThreadId]),
    ]);

    expect(
      ticks.reduce((total, tick) => {
        return total + tick.indexedEvents;
      }, 0),
    ).toBe(2);
    const projection = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(projection.indexedSeqId).toBe(projection.lastChatEventSeqId);
    expect(
      projection.messages.filter((message) => {
        return message.text === assistantText;
      }),
    ).toHaveLength(1);
  });

  it("does not take a thread lock that conflicts with event writes", async () => {
    const chatThreadId = await createProjectionThread();
    await insertChatSearchProjectionCoverageFixture({
      chatThreadId,
      promptText: `nonblocking prompt ${randomUUID()}`,
      assistantText: `nonblocking assistant ${randomUUID()}`,
      errorText: `nonblocking error ${randomUUID()}`,
      terminalText: `nonblocking terminal ${randomUUID()}`,
    });
    const appendedText = `writer remains live ${randomUUID()}`;
    const heldWriter = await holdChatEventInsertTransactionFixture({
      threadId: chatThreadId,
      content: appendedText,
      signal: context.signal,
    });
    const firstTick = projectOwnedChatEventSearch([chatThreadId]);
    onTestFinished(async () => {
      heldWriter.release();
      await Promise.allSettled([heldWriter.done, firstTick]);
    });

    const projected = await firstTick;
    expect(projected.indexedEvents).toBe(2);

    heldWriter.release();
    await heldWriter.done;
    const caughtUp = await projectOwnedChatEventSearch([chatThreadId]);
    expect(caughtUp.indexedEvents).toBe(1);
    const projection = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(projection.indexedSeqId).toBe(projection.lastChatEventSeqId);
    expect(projection.messages).toContainEqual(
      expect.objectContaining({
        seqId: heldWriter.event.seqId,
        role: "assistant",
        text: appendedText,
      }),
    );
  });

  it("skips a thread whose deletion commits during projection", async () => {
    const actor = bdd.user();
    const agent = await chat.createAgentForChatThread(actor);
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: `Projection deletion ${randomUUID()}`,
    });
    await insertChatSearchProjectionCoverageFixture({
      chatThreadId: thread.id,
      promptText: `deleting prompt ${randomUUID()}`,
      assistantText: `deleting assistant ${randomUUID()}`,
      errorText: `deleting error ${randomUUID()}`,
      terminalText: `deleting terminal ${randomUUID()}`,
    });
    const heldDeletion = await holdChatThreadDeleteTransactionFixture({
      threadId: thread.id,
      signal: context.signal,
    });
    const tick = projectOwnedChatEventSearch([thread.id]);
    onTestFinished(async () => {
      heldDeletion.release();
      await Promise.all([heldDeletion.done, tick]);
    });

    await expect
      .poll(heldDeletion.firstBlockedStatementKind)
      .toBe("select_for_key_share");
    heldDeletion.release();
    await heldDeletion.done;

    const projected = await tick;
    expect(projected.success).toBeTruthy();
    expect(projected.threads).toBe(0);
    const deleted = await chat.requestReadThread(actor, thread.id, [404]);
    expect(deleted.status).toBe(404);
  });

  it("bounds each projection tick to the configured thread batch", async () => {
    const threadIds = [
      await createProjectionThread(),
      await createProjectionThread(),
    ];
    for (const chatThreadId of threadIds) {
      await insertChatSearchProjectionCoverageFixture({
        chatThreadId,
        promptText: `bounded prompt ${randomUUID()}`,
        assistantText: `bounded assistant ${randomUUID()}`,
        errorText: `bounded error ${randomUUID()}`,
        terminalText: `bounded terminal ${randomUUID()}`,
      });
    }
    const [selectedThreadId, deferredThreadId] = [...threadIds].sort();
    if (!selectedThreadId || !deferredThreadId) {
      throw new Error("Expected two bounded projection threads");
    }

    mockOptionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE", "1");
    const tick = await projectOwnedChatEventSearch(threadIds);

    expect(tick.threads).toBe(1);
    expect(tick.indexedEvents).toBe(2);
    const selected =
      await readChatEventSearchProjectionFixture(selectedThreadId);
    expect(selected.indexedSeqId).toBe(selected.lastChatEventSeqId);
    expect(selected.messages).toHaveLength(2);
    const deferred =
      await readChatEventSearchProjectionFixture(deferredThreadId);
    expect(deferred.indexedSeqId).toBeNull();
    expect(deferred.messages).toStrictEqual([]);
  });

  it("deletes a later-revoked message by thread and sequence", async () => {
    const chatThreadId = await createProjectionThread();
    const text = `revoked durable prompt ${randomUUID()}`;
    const target = await insertSearchablePromptFixture({ chatThreadId, text });
    await projectOwnedChatEventSearch([chatThreadId]);

    const before = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(before.messages).toStrictEqual([
      {
        seqId: target.seqId,
        runId: null,
        role: "user",
        text,
      },
    ]);

    const replacement = await rejectSearchablePromptFixture({
      chatThreadId,
      eventId: target.id,
      text,
    });
    const tick = await projectOwnedChatEventSearch([chatThreadId]);
    expect(tick.deletedDocs).toBeGreaterThanOrEqual(1);

    const after = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(after.messages).toStrictEqual([
      {
        seqId: replacement.seqId,
        runId: null,
        role: "user",
        text,
      },
    ]);
    expect(after.messages[0]?.seqId).not.toBe(target.seqId);
    expect(after.indexedSeqId).toBe(after.lastChatEventSeqId);
  });
});
