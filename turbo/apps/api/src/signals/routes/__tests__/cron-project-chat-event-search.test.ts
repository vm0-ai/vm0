import { randomUUID } from "node:crypto";

import { cronProjectChatEventSearchContract } from "@vm0/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  insertChatSearchProjectionCoverageFixture,
  insertSearchablePromptFixture,
  readChatEventSearchProjectionFixture,
  rejectSearchablePromptFixture,
  resetDurableChatEventSearchProjectionFixture,
} from "../../../test-fixtures/chat-event-search";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
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

async function createProjectionThread(): Promise<string> {
  const actor = bdd.user();
  const compose = await chat.createComposeForChatThread(actor);
  const thread = await chat.createThread(actor, {
    agentId: compose.composeId,
    title: `Projection ${randomUUID()}`,
  });
  return thread.id;
}

describe("GET /api/cron/project-chat-event-search", () => {
  it("dual-projects only non-empty visible user and assistant messages", async () => {
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

    const tick = await projectChatEventSearch();
    expect(tick.success).toBeTruthy();
    expect(tick.durableThreads).toBeGreaterThanOrEqual(1);
    expect(tick.durableIndexedMessages).toBeGreaterThanOrEqual(2);
    expect(tick.convergence.eligibleThreads).toBeGreaterThanOrEqual(
      tick.convergence.legacyCaughtUpThreads,
    );
    expect(tick.convergence.eligibleThreads).toBeGreaterThanOrEqual(
      tick.convergence.durableCaughtUpThreads,
    );
    expect(tick.convergence.legacyCaughtUpThreads).toBeGreaterThanOrEqual(1);
    expect(tick.convergence.durableCaughtUpThreads).toBeGreaterThanOrEqual(1);

    const projection = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(
      projection.legacyDocs
        .map((doc) => {
          return [doc.role, doc.text];
        })
        .sort(),
    ).toStrictEqual(
      [
        ["assistant", assistantText],
        ["user", promptText],
      ].sort(),
    );
    expect(projection.durableMessages).toStrictEqual([
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
    expect(projection.legacyIndexedSeqId).toBe(projection.lastChatEventSeqId);
    expect(projection.durableIndexedSeqId).toBe(projection.lastChatEventSeqId);
  });

  it("backfills the durable projection from zero independently and idempotently", async () => {
    const chatThreadId = await createProjectionThread();
    await insertChatSearchProjectionCoverageFixture({
      chatThreadId,
      promptText: `backfill prompt ${randomUUID()}`,
      assistantText: `backfill assistant ${randomUUID()}`,
      errorText: `backfill error ${randomUUID()}`,
      terminalText: `backfill terminal ${randomUUID()}`,
    });
    await projectChatEventSearch();
    const established =
      await readChatEventSearchProjectionFixture(chatThreadId);

    await resetDurableChatEventSearchProjectionFixture(chatThreadId);
    const rolloutStart =
      await readChatEventSearchProjectionFixture(chatThreadId);
    expect(rolloutStart.legacyIndexedSeqId).toBe(
      rolloutStart.lastChatEventSeqId,
    );
    expect(rolloutStart.durableIndexedSeqId).toBeNull();
    expect(rolloutStart.durableMessages).toStrictEqual([]);

    await Promise.all([projectChatEventSearch(), projectChatEventSearch()]);

    const backfilled = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(backfilled.legacyIndexedSeqId).toBe(established.legacyIndexedSeqId);
    expect(backfilled.durableIndexedSeqId).toBe(backfilled.lastChatEventSeqId);
    expect(backfilled.durableMessages).toStrictEqual(
      established.durableMessages,
    );
  });

  it("keeps bounded rollout batches focused on serving projection lag", async () => {
    const servingThreadId = await createProjectionThread();
    const backfillThreadId = await createProjectionThread();
    for (const chatThreadId of [servingThreadId, backfillThreadId]) {
      await insertChatSearchProjectionCoverageFixture({
        chatThreadId,
        promptText: `bounded prompt ${randomUUID()}`,
        assistantText: `bounded assistant ${randomUUID()}`,
        errorText: `bounded error ${randomUUID()}`,
        terminalText: `bounded terminal ${randomUUID()}`,
      });
    }
    await projectChatEventSearch();
    await resetDurableChatEventSearchProjectionFixture(backfillThreadId);
    const tail = await insertSearchablePromptFixture({
      chatThreadId: servingThreadId,
      text: `serving tail ${randomUUID()}`,
    });

    mockOptionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE", "1");
    const tick = await projectChatEventSearch();

    expect(tick.threads).toBe(1);
    expect(tick.indexedEvents).toBe(1);
    expect(tick.durableThreads).toBe(1);
    expect(tick.durableIndexedMessages).toBe(1);
    const serving = await readChatEventSearchProjectionFixture(servingThreadId);
    expect(serving.legacyIndexedSeqId).toBe(tail.seqId);
    expect(serving.durableIndexedSeqId).toBe(tail.seqId);
    const backfill =
      await readChatEventSearchProjectionFixture(backfillThreadId);
    expect(backfill.durableIndexedSeqId).toBeNull();
  });

  it("deletes a later-revoked durable message by thread and sequence", async () => {
    const chatThreadId = await createProjectionThread();
    const text = `revoked durable prompt ${randomUUID()}`;
    const target = await insertSearchablePromptFixture({ chatThreadId, text });
    await projectChatEventSearch();

    const before = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(before.durableMessages).toStrictEqual([
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
    const tick = await projectChatEventSearch();
    expect(tick.deletedDocs).toBeGreaterThanOrEqual(1);
    expect(tick.durableDeletedMessages).toBeGreaterThanOrEqual(1);

    const after = await readChatEventSearchProjectionFixture(chatThreadId);
    expect(after.legacyDocs).toStrictEqual([
      { eventId: replacement.id, role: "user", text },
    ]);
    expect(after.durableMessages).toStrictEqual([
      {
        seqId: replacement.seqId,
        runId: null,
        role: "user",
        text,
      },
    ]);
    expect(after.durableMessages[0]?.seqId).not.toBe(target.seqId);
    expect(after.durableIndexedSeqId).toBe(after.lastChatEventSeqId);
  });
});
