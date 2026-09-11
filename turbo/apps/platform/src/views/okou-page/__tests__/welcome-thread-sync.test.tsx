import { act, screen, waitFor } from "@testing-library/react";
import { welcomeChatThreadsContract } from "@okouai/api-contracts/contracts/welcome-chat-threads";
import {
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  sharedDatabaseClientMessageSchema,
  sharedDatabaseWorkerMessageSchema,
} from "../../../shared-database/protocol.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
} from "../../../shared-database/data-key.ts";
import { SharedDatabaseMessagePortServer } from "../../../shared-database/message-port-server.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";
import { chatListEvent, fastButton } from "./chat-list-test-helpers.ts";

const context = testContext();
const INITIAL_PATH = "/chats/b0000000-0000-4000-a000-000000033301";
const MISSING_PATH = "/chats/b0000000-0000-4000-a000-000000033302";
const AGENT_PATH = "/agents/c0000000-0000-4000-a000-000000000071/chat";

function navigate(path: string) {
  act(() => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

// Delay only transport delivery. Queries run through the real server and
// worker; cancellation and late-result handling stay in the production client.
function installWorker(
  onThreadListResponse: (
    query: SharedDatabaseQuery<SharedDatabaseDataKey>,
    deliver: () => Promise<void>,
  ) => boolean,
) {
  class SharedWorkerMock extends EventTarget {
    readonly port: MessagePort;

    constructor() {
      super();
      const channel = new MessageChannel();
      this.port = channel.port1;
      const queries = new Map<
        string,
        SharedDatabaseQuery<SharedDatabaseDataKey>
      >();
      const sendRequest = channel.port1.postMessage.bind(channel.port1);
      vi.spyOn(channel.port1, "postMessage").mockImplementation(
        (value: unknown) => {
          const request = sharedDatabaseClientMessageSchema.parse(value);
          if (
            request.type === "query" &&
            request.query.dataKey.kind === "chat-thread-event"
          ) {
            queries.set(request.requestId, request.query);
          }
          sendRequest(value);
        },
      );
      const sendResponse = channel.port2.postMessage.bind(channel.port2);
      vi.spyOn(channel.port2, "postMessage").mockImplementation(
        (value: unknown) => {
          const response = sharedDatabaseWorkerMessageSchema.parse(value);
          if (response.type === "result" || response.type === "error") {
            const query = queries.get(response.requestId);
            queries.delete(response.requestId);
            if (query) {
              const held = onThreadListResponse(query, async () => {
                const received = context.mocks.deferred<void>();
                const onMessage = (event: MessageEvent<unknown>) => {
                  const message = sharedDatabaseWorkerMessageSchema.parse(
                    event.data,
                  );
                  if (
                    (message.type === "result" || message.type === "error") &&
                    message.requestId === response.requestId
                  ) {
                    channel.port1.removeEventListener("message", onMessage);
                    received.resolve();
                  }
                };
                channel.port1.addEventListener("message", onMessage, {
                  signal: context.signal,
                });
                sendResponse(value);
                await received.promise;
              });
              if (held) {
                return;
              }
            }
          }
          sendResponse(value);
        },
      );
      new SharedDatabaseMessagePortServer(
        context.workerStore,
        channel.port2,
        context.signal,
      );
    }
  }
  vi.stubGlobal("SharedWorker", SharedWorkerMock);
}

function installWelcomeChat() {
  const chat = createMarkdownChatFixture(context);
  const row = {
    ...chat.outputMessage("Persisted welcome after dismissal", { seqId: 1 }),
    runId: null,
    runEventId: null,
    runEventSequenceNumber: null,
  };
  chat.install({
    rows: () => {
      return [row];
    },
  });
  const created = chatListEvent(33_303, 2, "created", chat.threadId, {
    agentId: "c0000000-0000-4000-a000-000000000071",
    title: "Committed welcome",
  });
  let committed = false;
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [],
      latestEventId: "d0000000-0000-4000-a000-000000000001",
      latestSeqId: 1,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: committed && (query.sinceSeqId ?? 0) < 2 ? [created] : [],
      hasMore: false,
    });
  });
  context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "CHAT_THREAD_NOT_FOUND",
        message: "Chat thread not found",
      },
    });
  });
  context.mocks.api(welcomeChatThreadsContract.create, ({ respond }) => {
    committed = true;
    return respond(201, { id: chat.threadId });
  });
  return {
    chat,
    created,
    isCommitted: () => {
      return committed;
    },
  };
}

async function openSyncedDebug() {
  await setupPage({
    context,
    path: `${INITIAL_PATH}?settings=debug`,
    sharedWorkerTestTransport: "browser",
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
  // This authoritative result proves initial list synchronization is complete.
  await screen.findByRole("heading", { name: "Chat thread not found" });
  await screen.findByRole("dialog", { name: "Settings" });
}

async function closeSettings() {
  click(screen.getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
}

async function openCommittedWelcome() {
  navigate(AGENT_PATH);
  await screen.findByRole("textbox", { name: "Message" });
  const welcomeLink = await waitFor(() => {
    const link = queryAllByRoleFast("link").find((candidate) => {
      return candidate.textContent?.includes("Committed welcome");
    });
    if (!link) {
      throw new Error("Committed welcome is missing from the ordinary list");
    }
    return link;
  });
  click(welcomeLink);
  await screen.findByText("Persisted welcome after dismissal");
}

test.each(["cache-only", "catch-up"] as const)(
  "Closing Settings after welcome 201 during %s preserves cold not-found and committed history",
  async (stage) => {
    const { chat, created, isCommitted } = installWelcomeChat();
    const held = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const cacheResponse = context.mocks.deferred<() => Promise<void>>();
    let cacheHeld = false;
    installWorker((query, deliver) => {
      if (
        isCommitted() &&
        stage === "cache-only" &&
        !cacheHeld &&
        query.consistency === "cache-only"
      ) {
        cacheHeld = true;
        cacheResponse.resolve(deliver);
        held.resolve();
        return true;
      }
      return false;
    });
    context.mocks.api(
      chatThreadsContract.events,
      async ({ query, respond }) => {
        if (isCommitted() && stage === "catch-up") {
          held.resolve();
          await release.promise;
        }
        return respond(200, {
          events: isCommitted() && (query.sinceSeqId ?? 0) < 2 ? [created] : [],
          hasMore: false,
        });
      },
    );
    await openSyncedDebug();
    click(fastButton("Create welcome thread"));
    await held.promise;
    expect(fastButton("Creating…")).toBeDisabled();
    await closeSettings();
    if (stage === "cache-only") {
      const deliver = await cacheResponse.promise;
      await deliver();
    } else {
      release.resolve();
    }

    // Same app, a different cold thread, and no unrelated realtime delivery.
    navigate("/agents");
    await screen.findByRole("heading", { name: "Agents" });
    navigate(MISSING_PATH);
    await screen.findByRole("heading", { name: "Chat thread not found" });
    expect(window.location.pathname).toBe(MISSING_PATH);
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    await openCommittedWelcome();
    expect(window.location.pathname).toBe(chat.path);
  },
);

test("A failed committed welcome sync remains an error and permits ordinary recovery", async () => {
  const { chat, created, isCommitted } = installWelcomeChat();
  let unavailable = true;
  installWorker(() => {
    return false;
  });
  context.mocks.http.get("*/api/chat-threads/events", ({ request }) => {
    if (isCommitted() && unavailable) {
      return HttpResponse.json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "List temporarily unavailable",
          },
        },
        { status: 503 },
      );
    }
    const sinceSeqId = Number(
      new URL(request.url).searchParams.get("sinceSeqId"),
    );
    return HttpResponse.json({
      events: isCommitted() && sinceSeqId < 2 ? [created] : [],
      hasMore: false,
    });
  });
  await openSyncedDebug();
  click(fastButton("Create welcome thread"));
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Could not create the welcome thread. Try again.",
  );
  expect(fastButton("Create welcome thread")).toBeEnabled();
  expect(window.location.pathname).toBe(INITIAL_PATH);
  unavailable = false;
  await closeSettings();
  navigate("/agents");
  await screen.findByRole("heading", { name: "Agents" });
  navigate(MISSING_PATH);
  await screen.findByRole("heading", { name: "Chat thread not found" });
  await openCommittedWelcome();
  expect(window.location.pathname).toBe(chat.path);
});
