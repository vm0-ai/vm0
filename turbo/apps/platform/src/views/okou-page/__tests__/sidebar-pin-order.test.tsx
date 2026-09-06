import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
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
    return expect(sidebarThreadTitles()).toStrictEqual([
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

function slot(title: string) {
  const element = handle(title).closest(
    '[data-testid="sidebar-chat-thread-virtual-row"]',
  );
  if (!element) {
    throw new Error(`Missing virtual row: ${title}`);
  }
  return element;
}

function dragEvent(
  type: "dragover" | "drop",
  element: Element,
  clientY: number,
  dataTransfer: DataTransfer,
) {
  // Happy DOM's DragEvent does not retain pointer coordinates.
  fireEvent(
    element,
    Object.assign(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientY }),
      { dataTransfer },
    ),
  );
}

function threadLink(title: string) {
  const link = sidebarThreadLinks().find((item) => {
    return item.textContent?.includes(title);
  });
  if (!link) {
    throw new Error(`Missing thread link: ${title}`);
  }
  return link;
}

function touchEvent(
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  target: Element,
  clientY: number,
  clientX = 50,
) {
  const touch = new Touch({ identifier: 1, target, clientX, clientY });
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === "touchend" || type === "touchcancel" ? [] : [touch],
    changedTouches: [touch],
  });
  fireEvent(target, event);
  return event;
}

test("long pressing the pinned row reorders it without a navigation click", async () => {
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ respond }) => {
    return respond(204);
  });
  await prepare(73);
  vi.spyOn(
    screen.getByTestId("pinned-thread-drop-zone"),
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 300, 500));
  const link = threadLink("Last pin");
  const pathname = window.location.pathname;
  touchEvent("touchstart", link, 90);
  const preview = await screen.findByTestId("pinned-thread-drag-preview");
  expect(preview).toHaveTextContent("Last pin");
  expect(touchEvent("touchmove", link, 52).defaultPrevented).toBeTruthy();
  expect(screen.getByTestId("pinned-thread-drop-placeholder")).toHaveStyle({
    transform: "translateY(36px)",
  });
  expect(touchEvent("touchend", link, 52).defaultPrevented).toBeTruthy();
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
  expect(preview).not.toBeInTheDocument();
  expect(window.location.pathname).toBe(pathname);
});

test("a tap or an early swipe leaves touch scrolling available and cancels pickup", async () => {
  await prepare(74);
  const link = threadLink("Last pin");
  touchEvent("touchstart", link, 90);
  expect(touchEvent("touchend", link, 90).defaultPrevented).toBeFalsy();
  touchEvent("touchstart", link, 90);
  expect(touchEvent("touchmove", link, 52).defaultPrevented).toBeFalsy();
  touchEvent("touchend", link, 52);

  // A subsequent pickup is the completion boundary for the cancelled holds.
  const next = threadLink("Second pin");
  touchEvent("touchstart", next, 52);
  const preview = await screen.findByTestId("pinned-thread-drag-preview");
  expect(preview).toHaveTextContent("Second pin");
  touchEvent("touchcancel", next, 52);
  expect(preview).not.toBeInTheDocument();
  expect(sidebarThreadTitles()).toStrictEqual([
    "First pin",
    "Second pin",
    "Last pin",
    "Regular thread",
  ]);
});

test("releasing a touch drag outside the sidebar leaves the pin order intact", async () => {
  await prepare(75);
  vi.spyOn(
    screen.getByTestId("pinned-thread-drop-zone"),
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 300, 500));
  const link = threadLink("Last pin");
  touchEvent("touchstart", link, 90);
  const preview = await screen.findByTestId("pinned-thread-drag-preview");
  touchEvent("touchmove", link, 52);
  expect(screen.getByTestId("pinned-thread-drop-placeholder")).toHaveStyle({
    transform: "translateY(36px)",
  });
  touchEvent("touchend", link, 52, 350);
  await waitFor(() => {
    expect(preview).not.toBeInTheDocument();
  });
  expect(sidebarThreadTitles()).toStrictEqual([
    "First pin",
    "Second pin",
    "Last pin",
    "Regular thread",
  ]);
});

test("collapsing the list cancels a touch pickup before it can reorder after remount", async () => {
  await prepare(76);
  touchEvent("touchstart", threadLink("Last pin"), 90);
  const title = document.querySelector(".okou-nav-recent-label");
  if (!title) {
    throw new Error("Missing chat list header");
  }
  fireEvent.click(title);
  expect(
    screen.queryByTestId("sidebar-chat-threads-virtual-list"),
  ).not.toBeInTheDocument();
  fireEvent.click(title);
  await waitFor(() => {
    expect(threadLink("First pin")).toBeInTheDocument();
  });
  const next = threadLink("First pin");
  touchEvent("touchstart", next, 16);
  const preview = await screen.findByTestId("pinned-thread-drag-preview");
  expect(preview).toHaveTextContent("First pin");
  touchEvent("touchcancel", next, 16);
  expect(preview).not.toBeInTheDocument();
  expect(sidebarThreadTitles()).toStrictEqual([
    "First pin",
    "Second pin",
    "Last pin",
    "Regular thread",
  ]);
});

test("keyboard reorder follows visual tab order and survives the matching persisted event", async () => {
  const caseId = 61;
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
  const { stream, snapshot } = await prepare(caseId);
  const grip = handle("Last pin");
  const row = slot("Last pin");
  const link = queryAllByRoleFast("link", row)[0];
  const menuButton = queryAllByRoleFast("button", row).find((button) => {
    return button.getAttribute("aria-label") === "Open chat menu";
  });
  const user = userEvent.setup();
  act(() => {
    grip.focus();
  });
  await user.keyboard("{Tab}");
  expect(link).toHaveFocus();
  await user.keyboard("{Tab}");
  expect(menuButton).toHaveFocus();
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(link).toHaveFocus();
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(grip).toHaveFocus();
  await user.keyboard(" ");
  await user.keyboard("{ArrowUp}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(grip).toHaveFocus();
  expect(grip).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("pinned-thread-drop-placeholder")).toHaveStyle({
    transform: "translateY(36px)",
  });
  await user.keyboard(" ");
  const event = await requested.promise;
  expect(event.chatThreadId).toBe(snapshot[2]?.id);
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
  expect(grip).toHaveFocus();
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
    return expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Persisted last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
});

test("keyboard cancel leaves the order intact without writing an event", async () => {
  const requests: string[] = [];
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ body, respond }) => {
    requests.push(body.pinOrder);
    return respond(204);
  });
  await prepare(62);
  const grip = handle("Last pin");
  fireEvent.keyDown(grip, { key: " " });
  fireEvent.keyDown(grip, { key: "ArrowUp" });
  expect(screen.getByText("Drop before Second pin")).toBeInTheDocument();
  expect(
    screen.queryByTestId("pinned-thread-drag-preview"),
  ).not.toBeInTheDocument();
  fireEvent.keyDown(grip, { key: "Escape" });
  expect(sidebarThreadTitles()).toStrictEqual([
    "First pin",
    "Second pin",
    "Last pin",
    "Regular thread",
  ]);
  expect(requests).toStrictEqual([]);
  expect(grip).toHaveAttribute("aria-pressed", "false");
  expect(
    screen.queryByTestId("pinned-thread-drop-placeholder"),
  ).not.toBeInTheDocument();
  expect(slot("Last pin")).toHaveStyle({ transform: "translateY(72px)" });
});

test("dragging between equal ranks updates the tied suffix optimistically", async () => {
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
  await prepare(63, true, true);
  const transfer = Object.assign(new DataTransfer(), {
    setDragImage: () => {},
  });
  const grip = handle("Last pin");
  const target = handle("Second pin").closest(".okou-thread-reorder-row");
  if (!target) {
    throw new Error("Missing target row");
  }
  const user = userEvent.setup();
  await user.click(grip);
  expect(grip).toHaveFocus();
  fireEvent.pointerDown(grip, { pointerType: "mouse", button: 0 });
  fireEvent.mouseDown(grip, { button: 0 });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.dragStart(grip, { dataTransfer: transfer });
  const preview = await screen.findByTestId("pinned-thread-drag-preview");
  expect(grip).not.toHaveFocus();
  expect(preview).toHaveTextContent("Last pin");
  expect(preview.querySelector("button, a")).toBeNull();
  expect(grip.closest("[data-dragging]")).toHaveAttribute(
    "data-dragging",
    "pointer",
  );
  dragEvent("dragover", target, 52, transfer);
  expect(screen.getByTestId("pinned-thread-drop-placeholder")).toHaveStyle({
    transform: "translateY(36px)",
  });
  dragEvent("drop", target, 52, transfer);
  expect(preview).not.toBeInTheDocument();
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
  expect(ranks).toStrictEqual(["a1", "a2"]);
  pending.resolve();
});

test("ending a drag outside the list clears its preview and placeholder", async () => {
  const requests: string[] = [];
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ body, respond }) => {
    requests.push(body.pinOrder);
    return respond(204);
  });
  await prepare(67);
  const transfer = Object.assign(new DataTransfer(), {
    setDragImage: () => {},
  });
  const grip = handle("Last pin");
  fireEvent.pointerDown(grip, { pointerType: "mouse", button: 0 });
  fireEvent.dragStart(grip, { dataTransfer: transfer });
  await screen.findByTestId("pinned-thread-drag-preview");
  dragEvent(
    "dragover",
    screen.getByTestId("pinned-thread-drop-zone"),
    -20,
    transfer,
  );
  expect(screen.getByTestId("pinned-thread-drop-placeholder")).toHaveStyle({
    transform: "translateY(0px)",
  });
  expect(slot("First pin")).toHaveStyle({ transform: "translateY(36px)" });
  fireEvent.dragEnd(document, { dataTransfer: transfer });
  expect(
    screen.queryByTestId("pinned-thread-drag-preview"),
  ).not.toBeInTheDocument();
  expect(document.querySelector("[data-dragging]")).toBeNull();
  expect(
    screen.queryByTestId("pinned-thread-drop-placeholder"),
  ).not.toBeInTheDocument();
  expect(slot("First pin")).toHaveStyle({ transform: "translateY(0px)" });
  expect(requests).toStrictEqual([]);
  expect(sidebarThreadTitles()).toStrictEqual([
    "First pin",
    "Second pin",
    "Last pin",
    "Regular thread",
  ]);
});

test("dropping in the padding between virtual rows reorders the pin", async () => {
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ respond }) => {
    return respond(204);
  });
  await prepare(71);
  const transfer = Object.assign(new DataTransfer(), {
    setDragImage: () => {},
  });
  const target = slot("Second pin");
  fireEvent.pointerDown(handle("Last pin"), {
    pointerType: "mouse",
    button: 0,
  });
  fireEvent.dragStart(handle("Last pin"), { dataTransfer: transfer });
  await screen.findByTestId("pinned-thread-drag-preview");
  // The padding belongs to the virtual slot, outside the inner thread row.
  dragEvent("dragover", target, 70, transfer);
  dragEvent("drop", target, 70, transfer);
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
  expect(
    screen.queryByTestId("pinned-thread-drag-preview"),
  ).not.toBeInTheDocument();
});

test("one placeholder moves through fixed slots and dropping above the list moves to first", async () => {
  const ranks: string[] = [];
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ body, respond }) => {
    ranks.push(body.pinOrder);
    return respond(204);
  });
  await prepare(72);
  const transfer = Object.assign(new DataTransfer(), {
    setDragImage: () => {},
  });
  const zone = screen.getByTestId("pinned-thread-drop-zone");
  const pinnedAgents = zone.querySelector(
    '[data-testid="pinned-agents-grid"], [data-testid="pinned-section-header"]',
  );
  if (!pinnedAgents) {
    throw new Error("Missing pinned-agent drop area above the chat list");
  }
  const list = screen.getByTestId("sidebar-chat-threads-virtual-list");
  const grip = handle("Last pin");
  fireEvent.pointerDown(grip, { pointerType: "mouse", button: 0 });
  fireEvent.dragStart(grip, { dataTransfer: transfer });
  await screen.findByTestId("pinned-thread-drag-preview");

  for (const { clientY, destination } of [
    { clientY: -80, destination: 0 },
    { clientY: 52, destination: 1 },
    { clientY: 54, destination: 1 },
    { clientY: 110, destination: 2 },
    { clientY: -80, destination: 0 },
  ]) {
    dragEvent("dragover", clientY < 0 ? pinnedAgents : zone, clientY, transfer);
    await waitFor(() => {
      expect(
        screen.getAllByTestId("pinned-thread-drop-placeholder"),
      ).toHaveLength(1);
      expect(screen.getByTestId("pinned-thread-drop-placeholder")).toHaveStyle({
        transform: `translateY(${destination * 36}px)`,
      });
      expect(slot("Last pin")).toHaveStyle({
        transform: `translateY(${destination * 36}px)`,
      });
    });
    expect(slot("First pin")).toHaveStyle({
      transform: `translateY(${destination === 0 ? 36 : 0}px)`,
    });
    expect(slot("Second pin")).toHaveStyle({
      transform: `translateY(${destination < 2 ? 72 : 36}px)`,
    });
    expect(list).toHaveStyle({ height: "144px" });
    expect(ranks).toStrictEqual([]);
  }

  dragEvent("drop", pinnedAgents, -80, transfer);
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Last pin",
      "First pin",
      "Second pin",
      "Regular thread",
    ]);
  });
  expect(ranks[0]! < "a0").toBeTruthy();
  expect(list).toHaveStyle({ height: "144px" });
  expect(
    screen.queryByTestId("pinned-thread-drop-placeholder"),
  ).not.toBeInTheDocument();
});

test("new pins receive a rank ahead of all existing pins", async () => {
  const pending = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<string | undefined>();
  context.mocks.api(chatThreadPinContract.pin, async ({ query, respond }) => {
    requested.resolve(query?.pinOrder);
    await pending.promise;
    return respond(204);
  });
  await prepare(64);
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
  click(menuButton);
  const pinItem = queryAllByRoleFast("menuitem").find((item) => {
    return item.textContent?.trim() === "Pin chat";
  });
  if (!pinItem) {
    throw new Error("Missing pin menu item");
  }
  click(pinItem);
  expect((await requested.promise)! < "a0").toBeTruthy();
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toStrictEqual([
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
  ).toStrictEqual([]);
});

test("touch users can move a pin through the thread menu", async () => {
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ respond }) => {
    return respond(204);
  });
  await prepare(66);
  const row = handle("Last pin").closest(".okou-thread-reorder-row");
  if (!row) {
    throw new Error("Missing last pin row");
  }
  const menuButton = queryAllByRoleFast("button", row).find((button) => {
    return button.getAttribute("aria-label") === "Open chat menu";
  });
  if (!menuButton) {
    throw new Error("Missing thread menu");
  }
  const user = userEvent.setup();
  await user.pointer([
    { keys: "[TouchA>]", target: menuButton },
    { keys: "[/TouchA]" },
  ]);
  const menu = await screen.findByRole("menu");
  const moveUp = queryAllByRoleFast("menuitem", menu).find((item) => {
    return item.textContent?.trim() === "Move up";
  });
  if (!moveUp) {
    throw new Error("Missing move up menu item");
  }
  click(moveUp);
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
});

test("a remotely invalidated keyboard drag stays cancelled after repin", async () => {
  const caseId = 68;
  const { stream, snapshot } = await prepare(caseId);
  const grip = handle("Last pin");
  const user = userEvent.setup();
  act(() => {
    grip.focus();
  });
  await user.keyboard(" {ArrowUp}");
  expect(grip).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Drop before Second pin")).toBeInTheDocument();

  const targetId = snapshot[1]!.id;
  const unpin = chatListEvent(caseId, 2, "unpinned", targetId);
  stream.setEvents([unpin]);
  changeChatThreadList();
  await waitFor(() => {
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.getAttribute("aria-label") === "Reorder Second pin";
      }),
    ).toBeFalsy();
  });
  expect(grip).toHaveAttribute("aria-pressed", "false");
  expect(grip).toHaveFocus();
  await user.keyboard("{Escape}");

  const repin = chatListEvent(caseId, 3, "pinned", targetId, {
    pinOrder: "a1",
  });
  stream.setEvents([unpin, repin]);
  changeChatThreadList();
  await waitFor(() => {
    expect(handle("Second pin")).toBeInTheDocument();
  });
  expect(grip).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByText("Drop before Second pin")).not.toBeInTheDocument();
});

test("list unmount clears pointer state before remount", async () => {
  await prepare(69);
  const transfer = Object.assign(new DataTransfer(), {
    setDragImage: () => {},
  });
  fireEvent.pointerDown(handle("Last pin"), {
    pointerType: "mouse",
    button: 0,
  });
  fireEvent.dragStart(handle("Last pin"), { dataTransfer: transfer });
  await screen.findByTestId("pinned-thread-drag-preview");
  const title = document.querySelector(".okou-nav-recent-label");
  if (!title) {
    throw new Error("Missing chat list header");
  }
  fireEvent.click(title);
  expect(
    screen.queryByTestId("sidebar-chat-threads-virtual-list"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByTestId("pinned-thread-drag-preview"),
  ).not.toBeInTheDocument();
  fireEvent.click(title);
  await waitFor(() => {
    expect(handle("Last pin")).toBeInTheDocument();
  });
  expect(handle("Last pin")).toHaveAttribute("aria-pressed", "false");
  fireEvent.dragOver(document, {
    clientX: 50,
    clientY: 50,
    dataTransfer: transfer,
  });
  expect(
    screen.queryByTestId("pinned-thread-drag-preview"),
  ).not.toBeInTheDocument();
  expect(document.querySelector("[data-dragging]")).toBeNull();
});

test("a remotely invalidated pointer drag stays cancelled without a dragend event", async () => {
  const caseId = 70;
  const { stream, snapshot } = await prepare(caseId);
  const transfer = Object.assign(new DataTransfer(), {
    setDragImage: () => {},
  });
  const grip = handle("Last pin");
  const target = handle("Second pin").closest(".okou-thread-reorder-row");
  if (!target) {
    throw new Error("Missing target row");
  }
  fireEvent.pointerDown(grip, { pointerType: "mouse", button: 0 });
  fireEvent.dragStart(grip, { dataTransfer: transfer });
  await screen.findByTestId("pinned-thread-drag-preview");
  dragEvent("dragover", target, 52, transfer);
  await screen.findByTestId("pinned-thread-drag-preview");

  const targetId = snapshot[1]!.id;
  const unpin = chatListEvent(caseId, 2, "unpinned", targetId);
  stream.setEvents([unpin]);
  changeChatThreadList();
  await waitFor(() => {
    expect(
      screen.queryByTestId("pinned-thread-drag-preview"),
    ).not.toBeInTheDocument();
  });

  stream.setEvents([
    unpin,
    chatListEvent(caseId, 3, "pinned", targetId, { pinOrder: "a1" }),
  ]);
  changeChatThreadList();
  await waitFor(() => {
    expect(handle("Second pin")).toBeInTheDocument();
  });
  fireEvent.dragOver(document, {
    dataTransfer: transfer,
    clientX: 50,
    clientY: 50,
  });
  expect(
    screen.queryByTestId("pinned-thread-drag-preview"),
  ).not.toBeInTheDocument();
  expect(document.querySelector("[data-dragging]")).toBeNull();
  expect(
    screen.queryByTestId("pinned-thread-drop-placeholder"),
  ).not.toBeInTheDocument();
  expect(sidebarThreadTitles()).toStrictEqual([
    "First pin",
    "Second pin",
    "Last pin",
    "Regular thread",
  ]);
});
