import { randomUUID } from "node:crypto";

import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  insertChatSearchProjectionCoverageFixture,
  insertSearchablePromptFixture,
  removeChatSearchSourceEventsFixture,
  renameChatSearchAgentFixture,
  updateChatSearchSourceThreadFixture,
} from "../../../test-fixtures/chat-event-search";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

async function projectChatSearchMessages(
  chatThreadIds: readonly string[],
): Promise<void> {
  const client = setupApp({
    context,
    routes: testChatEventSearchProjectionRoutes,
  })(testChatEventSearchProjectionContract);
  const response = await accept(
    client.project({ body: { chat_thread_ids: [...chatThreadIds] } }),
    [200],
  );
  expect(response.body.convergence.durableCaughtUpThreads).toBe(
    chatThreadIds.length,
  );
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

describe("GET /api/chat/search durable reader", () => {
  it("serves message identities and context after source events are deleted", async () => {
    const owner = bdd.user();
    const source = await createSearchThread(
      owner,
      `durable-reader-${randomUUID().slice(0, 8)}`,
    );
    const keyword = `durablereader${randomUUID().replaceAll("-", "")}`;
    const first = await insertChatSearchProjectionCoverageFixture({
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

    const search = await chat.searchChat(owner, keyword, {
      before: 10,
      after: 10,
    });
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
    expect(
      result.contextBefore.map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["context user before", "context assistant before"]);
    expect(
      result.contextAfter.map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["context assistant after"]);

    expect(result.contextBefore[0]).toMatchObject({
      chatThreadId: source.threadId,
      role: "user",
      seqId: first.prompt.seqId,
      runId: null,
    });
    expect(result.contextBefore[1]).toMatchObject({
      chatThreadId: source.threadId,
      role: "assistant",
      seqId: first.assistant.seqId,
      runId: first.assistantRunId,
    });
    expect(result.contextAfter[0]).toMatchObject({
      chatThreadId: source.threadId,
      role: "assistant",
      seqId: second.assistant.seqId,
      runId: second.assistantRunId,
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
});
