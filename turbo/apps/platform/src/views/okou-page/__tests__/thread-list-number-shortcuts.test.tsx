import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
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
  [FeatureSwitchKey.StableChatThreadNavigation]: true,
} as const;
const SEARCH_LABEL = "Search chats, messages, workflows, and artifacts...";

function hintKeys(container: ParentNode): string[] {
  return [...container.querySelectorAll("kbd")]
    .map((keycap) => {
      return keycap.textContent ?? "";
    })
    .filter((label) => {
      return /^(?:Ctrl|⌘|[1-9])$/.test(label);
    });
}

test.each([
  {
    platform: "Mac",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    modifier: "Meta",
    label: "⌘",
  },
  {
    platform: "Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    modifier: "Control",
    label: "Ctrl",
  },
])(
  "Reveal the first nine thread shortcuts after holding the modifier for 500 ms on $platform",
  async ({ userAgent, modifier, label }) => {
    context.mocks.browser.userAgent(userAgent);
    context.mocks.browser.matchMedia((query) => {
      return (
        query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
      );
    });
    const threads = Array.from({ length: 11 }, (_, index) => {
      return chatListThread(index + 1, `Thread ${index + 1}`, {
        pinnedAt: index < 2 ? `2026-08-01T00:5${2 - index}:00.000Z` : null,
      });
    });
    const workspace = await installContinuityWorkspace(context, {
      caseId: 40,
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
        "Thread 1",
        "Thread 2",
        "Thread 11",
        "Thread 10",
        "Thread 9",
        "Thread 8",
        "Thread 7",
        "Thread 6",
        "Thread 5",
        "Thread 4",
        "Thread 3",
      ]);
    });
    const list = screen.getByTestId("chat-list-column");
    const user = userEvent.setup();
    const pressedAt = now();
    await user.keyboard(`{${modifier}>}`);
    expect(hintKeys(list)).toStrictEqual([]);
    await waitFor(() => {
      expect(hintKeys(list)).toHaveLength(18);
    });
    expect(now() - pressedAt).toBeGreaterThanOrEqual(500);
    expect(hintKeys(list)).toStrictEqual(
      Array.from({ length: 9 }, (_, index) => {
        return [label, String(index + 1)];
      }).flat(),
    );
    await user.keyboard(`9{/${modifier}}`);
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${threads[4]!.id}`);
    });
    expect(hintKeys(list)).toStrictEqual([]);

    // A known shortcut can be used immediately, without waiting for its hint.
    await user.keyboard(`{${modifier}>}1{/${modifier}}`);
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${threads[0]!.id}`);
    });
  },
);

test("Cancel a short hold and clear hints on release, blur, and visibility loss", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const visibility = context.mocks.browser.visibilityState("visible");
  const thread = chatListThread(1, "Hold lifecycle");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 41,
    threads: [thread],
  });
  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    auth: workspace.auth,
    featureSwitches,
  });
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Hold lifecycle"]);
  });
  const list = screen.getByTestId("chat-list-column");
  const user = userEvent.setup();
  await user.keyboard("{Control>}{/Control}");
  expect(hintKeys(list)).toStrictEqual([]);
  const pressedAt = now();
  await user.keyboard("{Control>}");
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual(["Ctrl", "1"]);
  });
  expect(now() - pressedAt).toBeGreaterThanOrEqual(500);
  fireEvent.blur(window);
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual([]);
  });
  await user.keyboard("{/Control}{Control>}");
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual(["Ctrl", "1"]);
  });
  visibility.changeTo("hidden");
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual([]);
  });
  visibility.changeTo("visible");
  await user.keyboard("{/Control}");
});

test("Keep browser mode free of number shortcuts and react to display mode changes", async () => {
  const media = context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  const first = chatListThread(1, "Browser mode chat");
  const second = chatListThread(2, "Another chat");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 42,
    threads: [first, second],
  });
  await setupPage({
    context,
    path: `/chats/${first.id}`,
    auth: workspace.auth,
    featureSwitches,
  });
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Another chat",
      "Browser mode chat",
    ]);
  });
  const list = screen.getByTestId("chat-list-column");
  const shortcut = new KeyboardEvent("keydown", {
    key: "1",
    code: "Digit1",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(shortcut);
  expect(shortcut.defaultPrevented).toBeFalsy();
  expect(pathname()).toBe(`/chats/${first.id}`);
  expect(hintKeys(list)).toStrictEqual([]);

  const user = userEvent.setup();
  await user.keyboard("{Control>}{Shift>}f{/Shift}");
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  await waitFor(() => {
    expect(queryAllByRoleFast("option", dialog)).toHaveLength(2);
  });
  const search = within(dialog).getByPlaceholderText(SEARCH_LABEL);
  const searchShortcut = new KeyboardEvent("keydown", {
    key: "1",
    code: "Digit1",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  search.dispatchEvent(searchShortcut);
  expect(searchShortcut.defaultPrevented).toBeFalsy();
  expect(hintKeys(dialog)).toStrictEqual([]);
  expect(dialog).toBeInTheDocument();
  await user.keyboard("{/Control}{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  media.setMatches((query) => {
    return (
      query === "(display-mode: window-controls-overlay)" ||
      query === "(min-width: 48rem)"
    );
  });
  await user.keyboard("{Control>}");
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual(["Ctrl", "1", "Ctrl", "2"]);
  });
  media.setMatches((query) => {
    return query === "(min-width: 48rem)";
  });
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual([]);
  });
  await user.keyboard("1{/Control}");
  expect(pathname()).toBe(`/chats/${first.id}`);
  click(sidebarThreadLinks()[0]!);
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${second.id}`);
  });
});

test("Number filtered threads and give the search dialog priority over the list", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const first = chatListThread(1, "Unread target");
  const second = chatListThread(2, "Read target");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 43,
    threads: [first, second],
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [{ threadId: first.id, unreadAt: "2026-08-01T01:00:00.000Z" }],
    });
  });
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth: workspace.auth,
    featureSwitches,
  });
  await waitFor(() => {
    expect(sidebarThreadTitles()).toHaveLength(2);
  });
  click(fastButton("Open chat list menu"));
  const unreadOnly = queryAllByRoleFast("menuitem").find((item) => {
    return item.textContent?.trim() === "Unread only";
  });
  if (!unreadOnly) {
    throw new Error("Expected unread filter");
  }
  click(unreadOnly);
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Unread target"]);
  });
  const list = screen.getByTestId("chat-list-column");
  const user = userEvent.setup();
  await user.keyboard("{Control>}");
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual(["Ctrl", "1"]);
  });
  await user.keyboard("{Shift>}f{/Shift}");
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  await waitFor(() => {
    expect(hintKeys(dialog)).toStrictEqual(["Ctrl", "1"]);
  });
  expect(hintKeys(list)).toStrictEqual([]);
  await user.keyboard("1{/Control}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pathname()).toBe(`/chats/${first.id}`);
  });
});
