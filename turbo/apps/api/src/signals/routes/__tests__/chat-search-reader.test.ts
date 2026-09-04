import { randomUUID } from "node:crypto";

import { cronProjectChatEventSearchResponseSchema } from "@okouai/api-contracts/contracts/cron";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { describe, expect, it, onTestFinished } from "vitest";
import type { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now, withMockNowForTest } from "../../../lib/time";
import {
  insertChatSearchProjectionCoverageFixture,
  insertSearchablePromptFixture,
  removeChatSearchSourceEventsFixture,
  renameChatSearchAgentFixture,
  updateChatSearchSourceThreadFixture,
} from "../../../test-fixtures/chat-event-search";
import { holdChatThreadDeleteTransactionFixture } from "../../../test-fixtures/chat-events";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
type ChatSearchProjectionResponse = z.infer<
  typeof cronProjectChatEventSearchResponseSchema
>;

async function requestChatSearchProjection(
  chatThreadIds: readonly string[],
): Promise<ChatSearchProjectionResponse> {
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

async function projectChatSearchMessages(
  chatThreadIds: readonly string[],
): Promise<void> {
  const body = await requestChatSearchProjection(chatThreadIds);
  expect(body.convergence.durableCaughtUpThreads).toBe(chatThreadIds.length);
}

async function createSearchThread(
  actor: ApiTestUser,
  agentName: string,
): Promise<{ readonly agentId: string; readonly threadId: string }> {
  const agent = await chat.createAgentForChatThread(actor, agentName);
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: `Search reader ${randomUUID()}`,
  });
  return { agentId: agent.agentId, threadId: thread.id };
}

async function sendNoCreditMessage(
  actor: ApiTestUser,
  args: {
    readonly agentId: string;
    readonly threadId: string;
    readonly prompt: string;
  },
): Promise<void> {
  await api.ensureOrgModelProvider(actor);
  const sent = await chat.requestSendEvent(actor, args, [201]);
  if (sent.status !== 201 || sent.body.runId !== null) {
    throw new Error("Expected a no-credit send without a run");
  }
}

describe("GET /api/chat/search durable reader", () => {
  it("serves matched message identity after source events are deleted", async () => {
    const owner = bdd.user();
    const source = await createSearchThread(
      owner,
      `durable-reader-${randomUUID().slice(0, 8)}`,
    );
    const keyword = `durablereader${randomUUID().replaceAll("-", "")}`;
    await insertChatSearchProjectionCoverageFixture({
      chatThreadId: source.threadId,
      promptText: "context user before",
      assistantText: "context assistant before",
      errorText: `excludederror${randomUUID().replaceAll("-", "")}`,
      terminalText: `excludedterminal${randomUUID().replaceAll("-", "")}`,
    });
    const secondError = `seconderror${randomUUID().replaceAll("-", "")}`;
    const secondTerminal = `secondterminal${randomUUID().replaceAll("-", "")}`;
    const second = await insertChatSearchProjectionCoverageFixture({
      chatThreadId: source.threadId,
      promptText: `find ${keyword}`,
      assistantText: "context assistant after",
      errorText: secondError,
      terminalText: secondTerminal,
    });

    await projectChatSearchMessages([source.threadId]);
    await expect(
      removeChatSearchSourceEventsFixture([source.threadId]),
    ).resolves.toBeGreaterThan(0);

    const search = await chat.searchChat(owner, keyword);
    expect(search).toMatchObject({ hasMore: false });
    expect(search.results).toHaveLength(1);
    const result = search.results[0];
    if (!result) {
      throw new Error("Expected one durable chat search result");
    }

    expect(result.matchedMessage).toMatchObject({
      chatThreadId: source.threadId,
      role: "user",
      content: `find ${keyword}`,
      createdAt: expect.any(String),
      seqId: second.prompt.seqId,
      runId: null,
    });
    for (const excluded of [secondError, secondTerminal]) {
      const excludedSearch = await chat.searchChat(owner, excluded);
      expect(excludedSearch.results).toStrictEqual([]);
    }
  });

  it("uses projected scope and agent identity while resolving the current name", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    const peer = bdd.user({ orgId });
    const primary = await createSearchThread(
      owner,
      `projected-primary-${randomUUID().slice(0, 8)}`,
    );
    const replacement = await chat.createAgentForChatThread(
      owner,
      `source-replacement-${randomUUID().slice(0, 8)}`,
    );
    const keyword = `projectedscope${randomUUID().replaceAll("-", "")}`;
    const prompt = await insertSearchablePromptFixture({
      chatThreadId: primary.threadId,
      text: keyword,
    });
    await projectChatSearchMessages([primary.threadId]);

    const currentAgentName = `current-${randomUUID().slice(0, 8)}`;
    await renameChatSearchAgentFixture({
      agentId: primary.agentId,
      name: currentAgentName,
    });
    await updateChatSearchSourceThreadFixture({
      chatThreadId: primary.threadId,
      userId: peer.userId,
      agentId: replacement.agentId,
    });

    const byProjectedAgent = await chat.searchChat(owner, keyword, {
      agentId: primary.agentId,
    });
    expect(byProjectedAgent.results).toHaveLength(1);
    expect(byProjectedAgent.results[0]).toMatchObject({
      chatThreadId: primary.threadId,
      agentName: currentAgentName,
      matchedMessage: {
        chatThreadId: primary.threadId,
        seqId: prompt.seqId,
      },
    });

    const bySourceThreadAgent = await chat.searchChat(owner, keyword, {
      agentId: replacement.agentId,
    });
    expect(bySourceThreadAgent.results).toStrictEqual([]);
    const peerSearch = await chat.searchChat(peer, keyword);
    expect(peerSearch.results).toStrictEqual([]);
    const sameUserOtherOrg = bdd.user({ userId: owner.userId });
    const otherOrgSearch = await chat.searchChat(sameUserOtherOrg, keyword);
    expect(otherOrgSearch.results).toStrictEqual([]);
  });

  it("continues past orphan-only candidate pages and preserves hasMore", async () => {
    const owner = bdd.user();
    const keyword = `orphanpage${randomUUID().replaceAll("-", "")}`;
    const baseTime = now();
    const visible = await createSearchThread(
      owner,
      `visible-reader-${randomUUID().slice(0, 8)}`,
    );
    const orphanThreadIds: string[] = [];
    await withMockNowForTest(baseTime, async () => {
      await sendNoCreditMessage(owner, {
        agentId: visible.agentId,
        threadId: visible.threadId,
        prompt: keyword,
      });
      for (let index = 1; index <= 6; index++) {
        mockNow(baseTime + index * 1000);
        const orphan = await createSearchThread(
          owner,
          `orphan-reader-${randomUUID().slice(0, 8)}`,
        );
        orphanThreadIds.push(orphan.threadId);
        await sendNoCreditMessage(owner, {
          agentId: orphan.agentId,
          threadId: orphan.threadId,
          prompt: keyword,
        });
      }
    });

    // Each DELETE has already fired the compatibility trigger but remains
    // uncommitted while the lock-free projector reads the old MVCC row. The
    // projector can therefore write after the trigger and leave the expected
    // eventual-consistency orphan for reader filtering and cron repair.
    const heldDeletions = await Promise.all(
      orphanThreadIds.map(async (threadId) => {
        return await holdChatThreadDeleteTransactionFixture({
          threadId,
          signal: context.signal,
        });
      }),
    );
    onTestFinished(async () => {
      for (const heldDeletion of heldDeletions) {
        heldDeletion.release();
      }
      await Promise.all(
        heldDeletions.map((heldDeletion) => {
          return heldDeletion.done;
        }),
      );
    });

    await projectChatSearchMessages([visible.threadId, ...orphanThreadIds]);
    for (const heldDeletion of heldDeletions) {
      heldDeletion.release();
    }
    await Promise.all(
      heldDeletions.map((heldDeletion) => {
        return heldDeletion.done;
      }),
    );

    const search = await chat.searchChat(owner, keyword, { limit: 1 });
    expect(search.results).toHaveLength(1);
    expect(search.results[0]?.chatThreadId).toBe(visible.threadId);
    expect(search.hasMore).toBeFalsy();

    const cleanup = await requestChatSearchProjection(orphanThreadIds);
    expect(cleanup.orphanedThreads).toBe(orphanThreadIds.length);
    const clean = await requestChatSearchProjection(orphanThreadIds);
    expect(clean.orphanedThreads).toBe(0);
  }, 60_000);
});
