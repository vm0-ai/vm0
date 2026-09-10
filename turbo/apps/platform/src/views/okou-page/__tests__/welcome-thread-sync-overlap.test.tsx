import { act, screen, waitFor } from "@testing-library/react";
import { welcomeChatThreadsContract } from "@okouai/api-contracts/contracts/welcome-chat-threads";
import {
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";
import {
  chatListEvent,
  chatListThread,
  fastButton,
} from "./chat-list-test-helpers.ts";

const context = testContext();

function navigate(path: string) {
  act(() => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

test("An older list refresh cannot finish a newer welcome reader, including after reader navigation", async () => {
  const welcome = createMarkdownChatFixture(context);
  const row = {
    ...welcome.outputMessage("Welcome history in the second pane", {
      seqId: 1,
    }),
    runId: null,
    runEventId: null,
    runEventSequenceNumber: null,
  };
  welcome.install({
    rows: () => {
      return [row];
    },
  });
  const primary = chatListThread(1, "Primary conversation", {
    agentId: "c0000000-0000-4000-a000-000000000071",
  });
  const primaryPath = `/chats/${primary.id}`;
  const sidebarPath = `${primaryPath}?sidebar=${welcome.threadId}`;
  const renamed = chatListEvent(33_303, 2, "renamed", primary.id, {
    agentId: primary.agentId,
    title: "Primary conversation refreshed",
  });
  const created = chatListEvent(33_303, 3, "created", welcome.threadId, {
    agentId: primary.agentId,
    title: "Newly committed welcome",
  });
  const olderRequested = context.mocks.deferred<void>();
  const releaseOlder = context.mocks.deferred<void>();
  const newerRequested = context.mocks.deferred<void>();
  const releaseNewer = context.mocks.deferred<void>();
  let metadataRequested = context.mocks.deferred<void>();
  let refreshing = false;
  let committed = false;

  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [primary],
      latestEventId: "d0000000-0000-4000-a000-000000000001",
      latestSeqId: 1,
    });
  });
  context.mocks.api(chatThreadsContract.events, async ({ query, respond }) => {
    if (!refreshing) {
      return respond(200, { events: [], hasMore: false });
    }
    // Hold the older response before the worker persists its rename, so the
    // welcome refresh also starts from the initial authoritative snapshot.
    if (!committed) {
      if (!olderRequested.settled()) {
        olderRequested.resolve();
      }
      await releaseOlder.promise;
      return respond(200, {
        events: [renamed].filter((event) => {
          return event.seqId > (query.sinceSeqId ?? 0);
        }),
        hasMore: false,
      });
    }
    if (!newerRequested.settled()) {
      newerRequested.resolve();
    }
    await releaseNewer.promise;
    return respond(200, {
      events: [renamed, created].filter((event) => {
        return event.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    if (params.id === welcome.threadId && !metadataRequested.settled()) {
      metadataRequested.resolve();
    }
    return respond(404, {
      error: {
        code: "CHAT_THREAD_NOT_FOUND",
        message: "Chat thread not found",
      },
    });
  });
  context.mocks.api(welcomeChatThreadsContract.create, ({ respond }) => {
    committed = true;
    return respond(201, { id: welcome.threadId });
  });
  await setupPage({
    context,
    path: "/chats/b0000000-0000-4000-a000-000000033304?settings=debug",
    sharedWorkerTestTransport: "message-port",
    auth: {
      user: { id: `user_${context.resourceId}`, fullName: "Test User" },
      organization: {
        activeOrg: {
          id: `org_${context.resourceId}`,
          name: "Welcome workspace",
        },
        memberships: [{ id: `org_${context.resourceId}` }],
      },
    },
    featureSwitches: {
      [FeatureSwitchKey.OkouDebug]: true,
      [FeatureSwitchKey.WelcomeThread]: true,
    },
  });
  // The cold route proves the initial list sync finished and opens Debug
  // directly, without spending this race test on unrelated menu interactions.
  await screen.findByRole("heading", { name: "Chat thread not found" });
  await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() => {
    expect(
      context.mocks.ably.hasChannelSubscriptionOnChannel(
        `user-org:user_${context.resourceId}:org_${context.resourceId}`,
      ),
    ).toBeTruthy();
  });
  refreshing = true;
  context.mocks.ably.trigger("threadListChanged");
  await olderRequested.promise;
  click(fastButton("Create welcome thread"));
  await newerRequested.promise;
  click(screen.getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  navigate(sidebarPath);
  await screen.findByText("Primary conversation", {
    selector: '[data-testid="chat-thread-header-title"]',
  });
  await metadataRequested.promise;
  // Abandon one cold reader while the shared welcome synchronization continues.
  navigate(primaryPath);
  await screen.findByRole("textbox", { name: "Message" });
  metadataRequested = context.mocks.deferred<void>();
  navigate(sidebarPath);
  await metadataRequested.promise;

  releaseOlder.resolve();
  await screen.findByText("Primary conversation refreshed", {
    selector: '[data-testid="chat-thread-header-title"]',
  });
  expect(
    screen.queryByRole("heading", { name: "Chat thread not found" }),
  ).toBeNull();
  releaseNewer.resolve();
  // An incorrectly completed not-found pane does not retry merely because a
  // later list result includes this thread. Its ordinary history must appear.
  await screen.findByText("Newly committed welcome", {
    selector: '[data-testid="chat-thread-header-title"]',
  });
  expect(screen.getAllByRole("region", { name: "Chat thread" })).toHaveLength(
    2,
  );
  await screen.findByText("Welcome history in the second pane");
  expect(window.location.pathname).toBe(primaryPath);
  expect(new URL(window.location.href).searchParams.get("sidebar")).toBe(
    welcome.threadId,
  );
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Chat thread not found" }),
  ).toBeNull();
});
