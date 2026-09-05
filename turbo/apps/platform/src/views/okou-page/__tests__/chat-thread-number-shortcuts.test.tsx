import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListThread,
  fastButton,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();
const featureSwitches = {
  [FeatureSwitchKey.PinnedChatThreadSort]: true,
  [FeatureSwitchKey.ChatThreadNumberShortcuts]: true,
} as const;

function composerIn(threadId: string): HTMLElement {
  const composer = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"] [role="textbox"][aria-label="Message"]`,
  );
  if (!composer) {
    throw new Error(`Expected composer for ${threadId}`);
  }
  return composer;
}

test.each([
  {
    platform: "Mac",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    firstShortcutLabel: "⌃⇧1",
  },
  {
    platform: "Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    firstShortcutLabel: "Ctrl+Shift+1",
  },
])(
  "Open numbered chats on $platform while preserving drafts and a hidden list",
  async ({ userAgent, firstShortcutLabel }) => {
    context.mocks.browser.userAgent(userAgent);
    const threads = Array.from({ length: 11 }, (_, index) => {
      return chatListThread(index + 1, `Chat ${index + 1}`, {
        pinnedAt: index < 2 ? `2026-08-01T00:5${2 - index}:00.000Z` : null,
      });
    });
    const workspace = await installContinuityWorkspace(context, {
      caseId: 24,
      threads,
    });
    await setupPage({
      context,
      path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
      auth: workspace.auth,
      featureSwitches,
    });

    await waitFor(() => {
      expect(sidebarThreadTitles()).toStrictEqual([
        "Chat 1",
        "Chat 2",
        "Chat 11",
        "Chat 10",
        "Chat 9",
        "Chat 8",
        "Chat 7",
        "Chat 6",
        "Chat 5",
        "Chat 4",
        "Chat 3",
      ]);
    });
    const links = sidebarThreadLinks();
    expect(links[0]).toHaveAttribute("aria-keyshortcuts", "Control+Shift+1");
    expect(links[0]).toHaveAttribute("title", firstShortcutLabel);
    expect(links[8]).toHaveAttribute("aria-keyshortcuts", "Control+Shift+9");
    expect(links[9]).not.toHaveAttribute("aria-keyshortcuts");

    const newChatComposer = await screen.findByRole("textbox", {
      name: "Message",
    });
    newChatComposer.focus();
    await userEvent.keyboard("{Control>}{Shift>}1{/Shift}{/Control}");
    await waitFor(() => {
      expect(composerIn(threads[0]!.id)).toBeVisible();
    });
    await fill(composerIn(threads[0]!.id), "Keep this draft");
    composerIn(threads[0]!.id).focus();
    await userEvent.keyboard("{Control>}{Shift>}9{/Shift}{/Control}");

    await waitFor(() => {
      expect(composerIn(threads[4]!.id)).toBeVisible();
      expect(sidebarThreadLinks()[8]).toHaveAttribute("aria-current", "page");
    });
    click(await screen.findByLabelText("Hide chat list"));
    await waitFor(() => {
      expect(screen.queryByTestId("chat-list-column")).toBeNull();
    });
    composerIn(threads[4]!.id).focus();
    fireEvent.keyDown(composerIn(threads[4]!.id), {
      key: "!",
      code: "Digit1",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(composerIn(threads[0]!.id)).toHaveTextContent("Keep this draft");
    });
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  },
);

test("Numbered shortcuts follow the current agent's unread-filtered list", async () => {
  const first = chatListThread(1, "First pin", {
    pinnedAt: "2026-08-01T00:51:00.000Z",
  });
  const second = chatListThread(2, "Unread pin", {
    pinnedAt: "2026-08-01T00:50:00.000Z",
  });
  const third = chatListThread(3, "Unread regular chat");
  const foreign = chatListThread(4, "Other agent's pin", {
    agentId: "c7000000-0000-4000-a000-000000000002",
    pinnedAt: "2026-08-01T00:59:00.000Z",
  });
  const workspace = await installContinuityWorkspace(context, {
    caseId: 25,
    threads: [first, second, third, foreign],
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [second, third].map((thread) => {
        return { threadId: thread.id, unreadAt: "2026-08-01T01:00:00.000Z" };
      }),
    });
  });
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth: workspace.auth,
    featureSwitches,
  });

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Unread pin",
      "Unread regular chat",
    ]);
  });
  click(await screen.findByLabelText("Open chat list menu"));
  const unreadOnly = queryAllByRoleFast("menuitem").find((item) => {
    return item.textContent?.trim() === "Unread only";
  });
  if (!unreadOnly) {
    throw new Error("Expected unread-only menu item");
  }
  click(unreadOnly);
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Unread pin",
      "Unread regular chat",
    ]);
  });
  await userEvent.keyboard("{Control>}{Shift>}1{/Shift}{/Control}");

  await waitFor(() => {
    expect(composerIn(second.id)).toBeVisible();
    expect(sidebarThreadLinks()[0]).toHaveAttribute("aria-current", "page");
  });
});

test("Numbered shortcuts respect composition, repeats, dialogs, and missing slots", async () => {
  const first = chatListThread(1, "First chat");
  const second = chatListThread(2, "Second chat");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 26,
    threads: [first, second],
  });
  await setupPage({
    context,
    path: `/chats/${first.id}`,
    auth: workspace.auth,
    featureSwitches,
  });
  await waitFor(() => {
    expect(composerIn(first.id)).toBeVisible();
    expect(sidebarThreadLinks()).toHaveLength(2);
  });
  const composer = composerIn(first.id);
  composer.focus();
  for (const ignored of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { metaKey: true },
  ]) {
    const event = new KeyboardEvent("keydown", {
      key: "!",
      code: "Digit1",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      ...ignored,
    });
    composer.dispatchEvent(event);
    expect(event.defaultPrevented).toBeFalsy();
  }
  await userEvent.keyboard("{Control>}{Shift>}9{/Shift}{/Control}");
  expect(composerIn(first.id)).toBeVisible();

  fireEvent.keyDown(document.body, { key: "?", code: "Slash", shiftKey: true });
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Open chat 1–9")).toBeVisible();
  expect(within(dialog).queryByText("Set icon (Ctrl+Shift+1-9)")).toBeNull();
  expect(within(dialog).getByText("Change icon")).toBeVisible();
  const dialogEvent = new KeyboardEvent("keydown", {
    key: "!",
    code: "Digit1",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  dialog.dispatchEvent(dialogEvent);
  expect(dialogEvent.defaultPrevented).toBeFalsy();
  click(fastButton("Close keyboard shortcuts", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  composerIn(first.id).focus();
  await userEvent.keyboard("{Control>}{Shift>}1{/Shift}{/Control}");

  await waitFor(() => {
    expect(composerIn(second.id)).toBeVisible();
    expect(sidebarThreadTitles()).toStrictEqual(["Second chat", "First chat"]);
  });
});

test("A numbered shortcut opens the main pane when the side composer is focused", async () => {
  const main = chatListThread(1, "Main chat");
  const side = chatListThread(2, "Side chat");
  const target = chatListThread(3, "Target chat");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 27,
    threads: [main, side, target],
  });
  await setupPage({
    context,
    path: `/chats/${main.id}?sidebar=${side.id}`,
    auth: workspace.auth,
    featureSwitches,
  });

  await waitFor(() => {
    expect(composerIn(main.id)).toBeVisible();
    expect(composerIn(side.id)).toBeVisible();
    expect(sidebarThreadLinks()).toHaveLength(3);
  });
  composerIn(side.id).focus();
  await userEvent.keyboard("{Control>}{Shift>}1{/Shift}{/Control}");

  await waitFor(() => {
    expect(composerIn(target.id)).toBeVisible();
    expect(sidebarThreadLinks()[0]).toHaveAttribute("aria-current", "page");
  });
  expect(composerIn(side.id)).toBeVisible();
});
