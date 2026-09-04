import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chatThreadRenameContract,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
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
