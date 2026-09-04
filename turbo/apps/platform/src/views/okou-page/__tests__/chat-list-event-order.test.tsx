import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListAuth,
  chatListEvent,
  chatListThread,
  chatListThreadId,
  installChatListAgent,
  installChatListStream,
  seedChatListCache,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();

test("Conversation lifecycle events produce the current list", async () => {
  const auth = chatListAuth(5);
  const oldThread = chatListThread(31, "Old conversation");
  const newThreadId = chatListThreadId(32);
  await seedChatListCache(5, auth, [oldThread]);
  installChatListAgent(context);
  installChatListStream(context, {
    caseId: 5,
    snapshot: [oldThread],
    events: [
      chatListEvent(5, 2, "renamed", oldThread.id, {
        title: "Renamed old conversation",
      }),
      chatListEvent(5, 3, "sort_touched", oldThread.id),
      chatListEvent(5, 4, "created", newThreadId, {
        title: "Current conversation",
        selectedModel: "claude-sonnet-4-6",
      }),
      chatListEvent(5, 5, "deleted", oldThread.id),
    ],
  });

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
  });

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Current conversation"]);
  });
  const links = sidebarThreadLinks();
  expect(links).toHaveLength(1);
  expect(links[0]).toHaveAttribute("data-sidebar-chat-thread-id", newThreadId);
  expect(links[0]).toHaveAttribute("href", `/chats/${newThreadId}`);
});

test("A pinned conversation stays above newer unpinned items", async () => {
  const auth = chatListAuth(10);
  const oldest = chatListThread(33, "Oldest conversation");
  const middle = chatListThread(34, "Middle conversation");
  const newest = chatListThread(35, "Newest conversation");
  await seedChatListCache(10, auth, [oldest, middle, newest]);
  const remote = context.mocks.deferred<void>();
  installChatListAgent(context);
  installChatListStream(context, {
    caseId: 10,
    snapshot: [oldest, middle, newest],
    events: [chatListEvent(10, 2, "pinned", oldest.id)],
    remoteGate: remote.promise,
  });

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
  });

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Newest conversation",
      "Middle conversation",
      "Oldest conversation",
    ]);
  });
  remote.resolve();

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Oldest conversation",
      "Newest conversation",
      "Middle conversation",
    ]);
  });
  expect(sidebarThreadLinks()[0]).toHaveAttribute(
    "data-sidebar-chat-thread-id",
    oldest.id,
  );
});
