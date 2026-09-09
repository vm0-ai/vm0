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
  [FeatureSwitchKey.ChatQuickSwitch]: true,
} as const;
const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36";
const SEARCH_LABEL = "Search workspace...";

function hintKeys(container: ParentNode): string[] {
  return [...container.querySelectorAll("kbd")]
    .map((keycap) => {
      return keycap.textContent ?? "";
    })
    .filter((label) => {
      return /^⌥[ASDFG]$/.test(label);
    });
}

test.each([
  {
    platform: "Mac Chrome",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    maxTouchPoints: 0,
    modifier: "Alt",
    releaseModifiers: "{/Alt}",
    label: "⌥",
    fifthKey: "©",
  },
  {
    platform: "Mac Safari",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Safari/605.1.15",
    maxTouchPoints: 0,
    modifier: "Alt",
    releaseModifiers: "{/Alt}",
    label: "⌥",
    fifthKey: "©",
  },
  {
    platform: "iPad Safari with a desktop user agent",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Safari/605.1.15",
    maxTouchPoints: 5,
    modifier: "Alt",
    releaseModifiers: "{/Alt}",
    label: "⌥",
    fifthKey: "©",
  },
])(
  "Reveal the first five chat shortcuts after holding the modifier for 500 ms on $platform",
  async ({
    userAgent,
    maxTouchPoints,
    modifier,
    fifthKey,
    releaseModifiers,
    label,
  }) => {
    context.mocks.browser.userAgent(userAgent);
    context.mocks.browser.maxTouchPoints(maxTouchPoints);
    context.mocks.browser.matchMedia((query) => {
      return query === "(min-width: 48rem)";
    });
    const threads = Array.from({ length: 11 }, (_, index) => {
      return chatListThread(index + 1, `Thread ${index + 1}`, {
        pinnedAt: index < 2 ? `2026-08-01T00:5${2 - index}:00.000Z` : null,
      });
    });
    const remoteChatList = context.mocks.deferred<void>();
    const workspace = installContinuityWorkspace(context, {
      caseId: 40,
      threads,
      chatListRemoteGate: remoteChatList.promise,
    });
    await setupPage({
      context,
      path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
      ...workspace.pageOptions,
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
    expect(remoteChatList.settled()).toBeFalsy();
    const list = screen.getByTestId("chat-list-column");
    const user = userEvent.setup();
    await user.hover(sidebarThreadLinks()[0]!);
    expect(hintKeys(list)).toStrictEqual([]);
    const pressedAt = now();
    await user.keyboard(`{${modifier}>}`);
    expect(hintKeys(list)).toStrictEqual([]);
    await waitFor(() => {
      expect(hintKeys(list)).toHaveLength(5);
    });
    expect(now() - pressedAt).toBeGreaterThanOrEqual(500);
    expect(hintKeys(list)).toStrictEqual(
      ["A", "S", "D", "F", "G"].map((key) => {
        return `${label}${key}`;
      }),
    );
    const composer = screen.getByRole("textbox", { name: "Message" });
    click(composer);
    fireEvent.keyDown(composer, {
      key: fifthKey,
      code: "KeyG",
      altKey: true,
    });
    await user.keyboard(releaseModifiers);
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${threads[8]!.id}`);
    });
    expect(hintKeys(list)).toStrictEqual([]);

    // A known shortcut can be used immediately, without waiting for its hint.
    await user.keyboard(`{${modifier}>}a${releaseModifiers}`);
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${threads[0]!.id}`);
    });
  },
);

test("Cancel a short hold and clear hints on release, blur, and visibility loss", async () => {
  context.mocks.browser.userAgent(MAC_USER_AGENT);
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const visibility = context.mocks.browser.visibilityState("visible");
  const thread = chatListThread(1, "Hold lifecycle");
  const workspace = installContinuityWorkspace(context, {
    caseId: 41,
    threads: [thread],
  });
  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
    featureSwitches,
  });
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Hold lifecycle"]);
  });
  const list = screen.getByTestId("chat-list-column");
  const user = userEvent.setup();
  await user.keyboard("{Alt>}{/Alt}");
  expect(hintKeys(list)).toStrictEqual([]);
  const pressedAt = now();
  await user.keyboard("{Alt>}");
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual(["⌥A"]);
  });
  expect(now() - pressedAt).toBeGreaterThanOrEqual(500);
  fireEvent.blur(window);
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual([]);
  });
  await user.keyboard("{/Alt}{Alt>}");
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual(["⌥A"]);
  });
  visibility.changeTo("hidden");
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual([]);
  });
  visibility.changeTo("visible");
  await user.keyboard("{/Alt}");
});

test.each([
  {
    platform: "Mac browser",
    userAgent: MAC_USER_AGENT,
    standalone: false,
    enabled: false,
    modifier: "Meta",
  },
  {
    platform: "Mac app",
    userAgent: MAC_USER_AGENT,
    standalone: true,
    enabled: false,
    modifier: "Meta",
  },
  {
    platform: "Windows browser",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    standalone: false,
    enabled: true,
    modifier: "Control",
  },
])(
  "Preserve normal input and chat navigation when quick switch is unavailable in a $platform",
  async ({ userAgent, standalone, enabled, modifier }) => {
    context.mocks.browser.userAgent(userAgent);
    context.mocks.browser.matchMedia((query) => {
      return (
        query === "(min-width: 48rem)" ||
        (standalone && query === "(display-mode: standalone)")
      );
    });
    const first = chatListThread(1, "Current chat");
    const second = chatListThread(2, "Another chat");
    const workspace = installContinuityWorkspace(context, {
      caseId: 42,
      threads: [first, second],
    });
    await setupPage({
      context,
      path: `/chats/${first.id}`,
      ...workspace.pageOptions,
      featureSwitches: {
        ...featureSwitches,
        [FeatureSwitchKey.ChatQuickSwitch]: enabled,
      },
    });
    await waitFor(() => {
      expect(sidebarThreadTitles()).toStrictEqual([
        "Another chat",
        "Current chat",
      ]);
    });
    const list = screen.getByTestId("chat-list-column");
    const shortcut = new KeyboardEvent("keydown", {
      key: "å",
      code: "KeyA",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    const composer = screen.getByRole("textbox", { name: "Message" });
    click(composer);
    composer.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBeFalsy();
    expect(pathname()).toBe(`/chats/${first.id}`);
    expect(hintKeys(list)).toStrictEqual([]);

    const user = userEvent.setup();
    await user.keyboard(`{${modifier}>}{Shift>}f{/Shift}{/${modifier}}`);
    const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
    await waitFor(() => {
      expect(queryAllByRoleFast("option", dialog)).toHaveLength(2);
    });
    const search = within(dialog).getByPlaceholderText(SEARCH_LABEL);
    const searchShortcut = new KeyboardEvent("keydown", {
      key: "å",
      code: "KeyA",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    search.dispatchEvent(searchShortcut);
    expect(searchShortcut.defaultPrevented).toBeFalsy();
    expect(hintKeys(dialog)).toStrictEqual([]);
    expect(dialog).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    click(sidebarThreadLinks()[0]!);
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${second.id}`);
    });
  },
);

test("Show shortcuts for filtered chats and give the search dialog priority over the list", async () => {
  context.mocks.browser.userAgent(MAC_USER_AGENT);
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const first = chatListThread(1, "Unread target");
  const second = chatListThread(2, "Read target");
  const workspace = installContinuityWorkspace(context, {
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
    ...workspace.pageOptions,
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
  await user.keyboard("{Meta>}");
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual(["⌥A"]);
  });
  await user.keyboard("{Shift>}f{/Shift}");
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  await waitFor(() => {
    expect(hintKeys(dialog)).toStrictEqual(["⌥A"]);
  });
  expect(hintKeys(list)).toStrictEqual([]);
  await user.keyboard("{/Meta}{Alt>}a{/Alt}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pathname()).toBe(`/chats/${first.id}`);
  });
});
