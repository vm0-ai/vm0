import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  chatThreadPinOrderContract,
  chatThreadPinContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListAuth,
  chatListEvent,
  chatListThread,
  installChatListAgent,
  installChatListStream,
  seedChatListCache,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();
async function prepare(caseId: number, enabled = true, tied = false) {
  const auth = chatListAuth(caseId);
  const pinnedAt = "2026-09-01T00:00:00Z";
  const snapshot = [
    chatListThread(3, "First pin", {
      pinnedAt,
      pinOrder: enabled ? "a0" : "a2",
    }),
    chatListThread(2, "Second pin", { pinnedAt, pinOrder: tied ? "a0" : "a1" }),
    chatListThread(1, "Last pin", {
      pinnedAt,
      pinOrder: enabled ? "a2" : "a0",
    }),
    chatListThread(4, "Regular thread"),
  ];
  await seedChatListCache(caseId, auth, snapshot);
  installChatListAgent(context);
  const stream = installChatListStream(context, { caseId, snapshot });
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
    featureSwitches: { [FeatureSwitchKey.StableChatThreadNavigation]: enabled },
  });
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toEqual([
      "First pin",
      "Second pin",
      "Last pin",
      "Regular thread",
    ]);
  });
  return { stream, snapshot };
}
function handle(title: string) {
  const button = queryAllByRoleFast("button").find((item) => {
    return item.getAttribute("aria-label") === `Reorder ${title}`;
  });
  if (!button) {
    throw new Error(`Missing reorder handle: ${title}`);
  }
  return button;
}

test("keyboard reorder is optimistic and survives the matching persisted event", async () => {
  const caseId = 61;
  const { stream, snapshot } = await prepare(caseId);
  const pending = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<ChatThreadEvent>();
  context.mocks.api(
    chatThreadPinOrderContract.reorder,
    async ({ params, body, respond }) => {
      requested.resolve(
        chatListEvent(caseId, 2, "sort_touched", params.id, {
          id: body.eventId,
          pinOrder: body.pinOrder,
        }),
      );
      await pending.promise;
      return respond(204);
    },
  );
  const grip = handle("Last pin");
  fireEvent.keyDown(grip, { key: " " });
  fireEvent.keyDown(grip, { key: "ArrowUp" });
  fireEvent.keyDown(grip, { key: " " });
  const event = await requested.promise;
  expect(event.chatThreadId).toBe(snapshot[2]?.id);
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toEqual([
      "First pin",
      "Last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
  pending.resolve();
  stream.setEvents([
    event,
    chatListEvent(caseId, 3, "renamed", event.chatThreadId, {
      title: "Persisted last pin",
    }),
  ]);
  changeChatThreadList();
  await stream.eventsServed;
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toEqual([
      "First pin",
      "Persisted last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
});

test("keyboard cancel leaves the order intact without writing an event", async () => {
  await prepare(62);
  const requests: string[] = [];
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ body, respond }) => {
    requests.push(body.pinOrder);
    return respond(204);
  });
  const grip = handle("Last pin");
  fireEvent.keyDown(grip, { key: " " });
  fireEvent.keyDown(grip, { key: "ArrowUp" });
  expect(screen.getByText("Drop before Second pin")).toBeInTheDocument();
  fireEvent.keyDown(grip, { key: "Escape" });
  expect(sidebarThreadTitles()).toEqual([
    "First pin",
    "Second pin",
    "Last pin",
    "Regular thread",
  ]);
  expect(requests).toEqual([]);
  expect(grip).toHaveAttribute("aria-pressed", "false");
});

test("dragging between equal ranks updates the tied suffix optimistically", async () => {
  await prepare(63, true, true);
  const pending = context.mocks.deferred<void>();
  const ranks: string[] = [];
  context.mocks.api(
    chatThreadPinOrderContract.reorder,
    async ({ body, respond }) => {
      ranks.push(body.pinOrder);
      await pending.promise;
      return respond(204);
    },
  );
  const transfer = Object.assign(new DataTransfer(), {
    setDragImage: () => {},
  });
  const grip = handle("Last pin");
  const target = handle("Second pin").closest(".okou-thread-reorder-row");
  if (!target) {
    throw new Error("Missing target row");
  }
  fireEvent.dragStart(grip, { dataTransfer: transfer });
  expect(grip).toHaveAttribute("aria-pressed", "true");
  fireEvent(
    target,
    Object.assign(
      new MouseEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientY: -1,
      }),
      { dataTransfer: transfer },
    ),
  );
  expect(target).toHaveAttribute("data-drop-side", "before");
  fireEvent.drop(target, { dataTransfer: transfer });
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toEqual([
      "First pin",
      "Last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
  expect(ranks).toHaveLength(2);
  pending.resolve();
});

test("new pins receive a rank ahead of all existing pins", async () => {
  await prepare(64);
  const pending = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<string | undefined>();
  context.mocks.api(chatThreadPinContract.pin, async ({ query, respond }) => {
    requested.resolve(query?.pinOrder);
    await pending.promise;
    return respond(204);
  });
  const row = sidebarThreadLinks().find((link) => {
    return link.textContent?.includes("Regular thread");
  })?.parentElement;
  if (!row) {
    throw new Error("Missing regular thread");
  }
  const menuButton = queryAllByRoleFast("button", row).find((item) => {
    return item.getAttribute("aria-label") === "Open chat menu";
  });
  if (!menuButton) {
    throw new Error("Missing thread menu");
  }
  await click(menuButton);
  const pinItem = queryAllByRoleFast("menuitem").find((item) => {
    return item.textContent?.trim() === "Pin chat";
  });
  if (!pinItem) {
    throw new Error("Missing pin menu item");
  }
  await click(pinItem);
  expect((await requested.promise)! < "a0").toBe(true);
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toEqual([
      "Regular thread",
      "First pin",
      "Second pin",
      "Last pin",
    ]);
  });
  pending.resolve();
});

test("the switch hides reordering and preserves activity sorting", async () => {
  await prepare(65, false);
  expect(
    queryAllByRoleFast("button").filter((item) => {
      return item.getAttribute("aria-label")?.startsWith("Reorder ");
    }),
  ).toEqual([]);
});
