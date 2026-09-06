import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chatThreadRenameContract,
  chatThreadPinContract,
  chatThreadUnpinContract,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuitySidebarLink,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();

interface RenameRequest {
  readonly threadId: string;
  readonly title: string;
}

function threadContainer(threadId: string): HTMLElement {
  const container = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  if (!container) {
    throw new Error(`Expected chat pane ${threadId}`);
  }
  return container;
}

function composerIn(threadId: string): HTMLElement {
  const composer = threadContainer(threadId).querySelector<HTMLElement>(
    '[role="textbox"][aria-label="Message"]',
  );
  if (!composer) {
    throw new Error(`Expected composer for ${threadId}`);
  }
  return composer;
}

function pinnedIndicator(threadId: string): HTMLElement | null {
  const row = continuitySidebarLink(threadId).parentElement;
  if (!row) {
    throw new Error(`Expected sidebar row for ${threadId}`);
  }
  return within(row).queryByLabelText("Pinned");
}

function dispatchPinShortcut(
  target: HTMLElement,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "D",
    code: "KeyD",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  fireEvent(target, event);
  return event;
}

function installRenameBoundary(requests: RenameRequest[]): void {
  context.mocks.api(
    chatThreadRenameContract.rename,
    ({ body, params, respond }) => {
      requests.push({ threadId: params.id, title: body.title });
      return respond(204);
    },
  );
}

function expectPaneTitle(
  thread: ChatThreadSnapshotProjection,
  title: string,
): void {
  expect(threadContainer(thread.id)).toHaveTextContent(title);
}

test("Move between neighboring chats from the focused pane", async () => {
  const oldest = continuityThread(16, 1, "Oldest neighboring chat");
  const current = continuityThread(16, 2, "Current keyboard chat");
  const side = continuityThread(16, 3, "Side keyboard chat");
  const newest = continuityThread(16, 4, "Newest neighboring chat");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 16,
    threads: [oldest, current, side, newest],
  });

  await setupPage({
    context,
    path: `/chats/${current.id}?sidebar=${side.id}`,
    auth: workspace.auth,
  });

  await waitFor(() => {
    expect(composerIn(current.id)).toBeVisible();
    expect(composerIn(side.id)).toBeVisible();
    expect(threadContainer(side.id)).toBeVisible();
  });
  const mainComposer = composerIn(current.id);
  mainComposer.focus();
  await userEvent.keyboard("{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}");

  await waitFor(() => {
    expect(threadContainer(newest.id)).toBeVisible();
    expect(continuitySidebarLink(newest.id)).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(continuitySidebarLink(newest.id)).toHaveAttribute(
    "aria-current",
    "page",
  );
  expectPaneTitle(side, "Side keyboard chat");

  const sideContainer = threadContainer(side.id);
  sideContainer.focus();
  await userEvent.keyboard("{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}");

  await waitFor(() => {
    expect(threadContainer(current.id)).toBeVisible();
    expect(
      document.querySelector(`[data-chat-thread-container-id="${side.id}"]`),
    ).toBeNull();
    expect(continuitySidebarLink(newest.id)).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expectPaneTitle(newest, "Newest neighboring chat");
  expectPaneTitle(current, "Current keyboard chat");
});

test("Add, replace, or remove the focused chat icon", async () => {
  const current = continuityThread(18, 1, "Project plan");
  const emojiOnlySide = continuityThread(18, 2, "❓");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 18,
    threads: [current, emojiOnlySide],
  });
  const renameRequests: RenameRequest[] = [];
  installRenameBoundary(renameRequests);

  await setupPage({
    context,
    path: `/chats/${current.id}?sidebar=${emojiOnlySide.id}`,
    auth: workspace.auth,
    featureSwitches: { [FeatureSwitchKey.StableChatThreadNavigation]: true },
  });

  await waitFor(() => {
    expect(composerIn(current.id)).toBeVisible();
    expect(composerIn(emojiOnlySide.id)).toBeVisible();
    expect(threadContainer(emojiOnlySide.id)).toBeVisible();
  });
  const mainComposer = composerIn(current.id);
  mainComposer.focus();
  await userEvent.keyboard("{Shift>}{F2}{/Shift}");
  await screen.findByLabelText("Search emoji");
  const doneEmoji = document.querySelector<HTMLElement>(
    '[data-chat-thread-emoji="✅"]',
  );
  if (!doneEmoji) {
    throw new Error("Expected Done emoji option");
  }
  await userEvent.click(doneEmoji);

  await waitFor(() => {
    expect(renameRequests.at(-1)).toStrictEqual({
      threadId: current.id,
      title: "✅ Project plan",
    });
    expectPaneTitle(current, "Project plan");
    expect(continuitySidebarLink(current.id)).toHaveTextContent(
      "✅ Project plan",
    );
  });

  composerIn(current.id).focus();
  await userEvent.keyboard("{Control>}{Shift>}2{/Shift}{/Control}");
  await waitFor(() => {
    expect(renameRequests.at(-1)).toStrictEqual({
      threadId: current.id,
      title: "🔥 Project plan",
    });
    expect(continuitySidebarLink(current.id)).toHaveTextContent(
      "🔥 Project plan",
    );
  });
  expect(document.querySelector('[aria-label="Search emoji"]')).toBeNull();

  composerIn(current.id).focus();
  await userEvent.keyboard("{Control>}{Shift>}0{/Shift}{/Control}");
  await waitFor(() => {
    expect(renameRequests.at(-1)).toStrictEqual({
      threadId: current.id,
      title: "Project plan",
    });
    expect(continuitySidebarLink(current.id)).toHaveTextContent("Project plan");
  });

  const requestCountBeforeDeclinedRemoval = renameRequests.length;
  threadContainer(emojiOnlySide.id).focus();
  await userEvent.keyboard("{Control>}{Shift>}0{/Shift}{/Control}");
  expect(continuitySidebarLink(emojiOnlySide.id)).toHaveTextContent("❓");
  expect(threadContainer(emojiOnlySide.id)).toHaveTextContent("❓");
  expect(renameRequests).toHaveLength(requestCountBeforeDeclinedRemoval);
});

test("Show keyboard help without stealing composer input", async () => {
  const thread = continuityThread(19, 1, "Keyboard help chat");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 19,
    threads: [thread],
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    auth: workspace.auth,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await userEvent.type(composer, "?!");
  expect(composer).toHaveTextContent("?!");
  expect(document.body).not.toHaveTextContent("Keyboard Shortcuts");

  const container = threadContainer(thread.id);
  container.focus();
  fireEvent.keyDown(container, {
    key: "?",
    code: "Slash",
    shiftKey: true,
  });

  const heading = await screen.findByText("Keyboard Shortcuts");
  const dialog = heading.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) {
    throw new Error("Expected keyboard shortcut dialog");
  }
  expect(dialog).toHaveTextContent("Previous thread");
  expect(dialog).toHaveTextContent("Next thread");
  expect(dialog).toHaveTextContent("Rename chat");
  expect(dialog).toHaveTextContent("Change icon");
  expect(composer).toHaveTextContent("?!");
});

test.each([
  {
    platform: "Mac",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    modifier: "Meta",
  },
  {
    platform: "Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    modifier: "Control",
  },
])(
  "Pin and unpin the focused chat optimistically on $platform",
  async ({ userAgent, modifier }) => {
    context.mocks.browser.userAgent(userAgent);
    const main = continuityThread(70, 1, "Main pin shortcut chat");
    const side = continuityThread(70, 2, "Side pin shortcut chat");
    const workspace = await installContinuityWorkspace(context, {
      caseId: 70,
      threads: [main, side],
    });
    const pinRequested = context.mocks.deferred<void>();
    const pinResponse = context.mocks.deferred<void>();
    const unpinRequested = context.mocks.deferred<void>();
    context.mocks.api(chatThreadPinContract.pin, async ({ respond }) => {
      pinRequested.resolve();
      await pinResponse.promise;
      return respond(204);
    });
    context.mocks.api(chatThreadUnpinContract.unpin, ({ respond }) => {
      unpinRequested.resolve();
      return respond(204);
    });

    await setupPage({
      context,
      path: `/chats/${main.id}?sidebar=${side.id}`,
      auth: workspace.auth,
      featureSwitches: { [FeatureSwitchKey.ChatThreadPinShortcut]: true },
    });
    await waitFor(() => {
      expect(composerIn(main.id)).toBeVisible();
      expect(composerIn(side.id)).toBeVisible();
    });

    const sideComposer = composerIn(side.id);
    await userEvent.type(sideComposer, "Keep this draft");
    const event = dispatchPinShortcut(sideComposer, {
      metaKey: modifier === "Meta",
      ctrlKey: modifier === "Control",
    });
    expect(event.defaultPrevented).toBeTruthy();
    await pinRequested.promise;
    await waitFor(() => {
      expect(pinnedIndicator(side.id)).toBeVisible();
    });
    expect(pinnedIndicator(main.id)).toBeNull();
    expect(sideComposer).toHaveFocus();
    expect(sideComposer).toHaveTextContent("Keep this draft");
    pinResponse.resolve();

    await userEvent.keyboard(`{${modifier}>}{Shift>}D{/Shift}{/${modifier}}`);
    await unpinRequested.promise;
    await waitFor(() => {
      expect(pinnedIndicator(side.id)).toBeNull();
    });
    expect(sideComposer).toHaveTextContent("Keep this draft");

    threadContainer(main.id).focus();
    await userEvent.keyboard(`{${modifier}>}{Shift>}D{/Shift}{/${modifier}}`);
    await waitFor(() => {
      expect(pinnedIndicator(main.id)).toBeVisible();
    });
    expect(pinnedIndicator(side.id)).toBeNull();
  },
);

test("Pin the main chat when neither pane owns keyboard focus", async () => {
  const main = continuityThread(71, 1, "Default pin shortcut chat");
  const side = continuityThread(71, 2, "Other pin shortcut chat");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 71,
    threads: [main, side],
  });
  context.mocks.api(chatThreadPinContract.pin, ({ respond }) => {
    return respond(204);
  });
  await setupPage({
    context,
    path: `/chats/${main.id}?sidebar=${side.id}`,
    auth: workspace.auth,
    featureSwitches: { [FeatureSwitchKey.ChatThreadPinShortcut]: true },
  });
  await waitFor(() => {
    expect(composerIn(side.id)).toBeVisible();
  });
  const sideComposer = composerIn(side.id);
  sideComposer.focus();
  sideComposer.blur();
  expect(document.body).toHaveFocus();

  const event = dispatchPinShortcut(document.body);
  expect(event.defaultPrevented).toBeTruthy();
  await waitFor(() => {
    expect(pinnedIndicator(main.id)).toBeVisible();
  });
  expect(pinnedIndicator(side.id)).toBeNull();
});

test("Preserve the browser shortcut while the pin shortcut is disabled", async () => {
  const thread = continuityThread(72, 1, "Disabled pin shortcut chat");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 72,
    threads: [thread],
  });
  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    auth: workspace.auth,
    featureSwitches: { [FeatureSwitchKey.ChatThreadPinShortcut]: false },
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  composer.focus();
  const event = dispatchPinShortcut(composer);
  expect(event.defaultPrevented).toBeFalsy();

  threadContainer(thread.id).focus();
  await userEvent.keyboard("{Shift>}?{/Shift}");
  const dialog = await screen.findByRole("dialog");
  expect(dialog).not.toHaveTextContent("Pin / unpin chat");
});

test("Respect composition, held keys, dialogs, and navigation for pin shortcuts", async () => {
  const thread = continuityThread(73, 1, "Scoped pin shortcut chat");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 73,
    threads: [thread],
  });
  context.mocks.api(chatThreadPinContract.pin, ({ respond }) => {
    return respond(204);
  });
  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    auth: workspace.auth,
    featureSwitches: { [FeatureSwitchKey.ChatThreadPinShortcut]: true },
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  composer.focus();

  expect(
    dispatchPinShortcut(composer, { isComposing: true }).defaultPrevented,
  ).toBeFalsy();
  expect(
    dispatchPinShortcut(composer, { keyCode: 229 }).defaultPrevented,
  ).toBeFalsy();

  await userEvent.keyboard("{Control>}{Shift>}D{/Shift}{/Control}");
  await waitFor(() => {
    expect(pinnedIndicator(thread.id)).toBeVisible();
  });
  expect(
    dispatchPinShortcut(composer, { repeat: true }).defaultPrevented,
  ).toBeTruthy();
  expect(pinnedIndicator(thread.id)).toBeVisible();

  threadContainer(thread.id).focus();
  await userEvent.keyboard("{Shift>}?{/Shift}");
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("Pin / unpin chat");
  expect(dispatchPinShortcut(dialog).defaultPrevented).toBeFalsy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(pinnedIndicator(thread.id)).toBeVisible();

  const agentsLink = queryAllByRoleFast("link").find((link) => {
    return link.textContent?.trim() === "Agents";
  });
  if (!agentsLink) {
    throw new Error("Expected Agents navigation link");
  }
  click(agentsLink);
  await screen.findByRole("heading", { name: "Agents" });
  expect(dispatchPinShortcut(document.body).defaultPrevented).toBeFalsy();
});
