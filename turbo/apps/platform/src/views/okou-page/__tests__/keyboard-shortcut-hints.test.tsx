import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListThread,
  fastButton,
} from "./chat-list-test-helpers.ts";

const context = testContext();
const featureSwitches = {
  [FeatureSwitchKey.StableChatThreadNavigation]: true,
} as const;
const SEARCH_LABEL = "Search workspace...";

const platforms = [
  {
    platform: "Mac",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36",
    modifier: "Meta",
    hints: ["⌘⇧F", "⌘⇧O", "⌘B"],
    threadHint: "⌘1",
  },
  {
    platform: "Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    modifier: "Control",
    hints: ["Ctrl+Shift+F", "Ctrl+Shift+O", "Ctrl+B"],
    threadHint: "Ctrl+1",
  },
] as const;

test.each(platforms)(
  "Keep action shortcuts available on hover while holding the thread modifier in a $platform app",
  async ({ userAgent, modifier, hints, threadHint }) => {
    context.mocks.browser.userAgent(userAgent);
    context.mocks.browser.matchMedia((query) => {
      return (
        query === "(min-width: 48rem)" || query === "(display-mode: standalone)"
      );
    });
    const thread = chatListThread(1, "Keyboard hints");
    const workspace = await installContinuityWorkspace(context, {
      caseId: 60,
      threads: [thread],
    });
    await setupPage({
      context,
      path: `/chats/${thread.id}`,
      auth: workspace.auth,
      featureSwitches,
    });
    const composer = await screen.findByRole("textbox", { name: "Message" });
    click(composer);
    const list = screen.getByTestId("chat-list-column");
    expect(within(list).getByLabelText("Search workspace")).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+Shift+F Control+Shift+F",
    );
    expect(fastButton("New chat", list)).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+Shift+O Control+Shift+O",
    );
    expect(within(list).getByLabelText("Hide chat list")).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+B Control+B",
    );

    const user = userEvent.setup();
    const searchButton = within(list).getByLabelText("Search workspace");
    await user.hover(searchButton);
    const searchHover = await screen.findByRole("tooltip", {
      name: `Search workspace ${hints[0]}`,
    });
    const pressedAt = now();
    await user.keyboard(`{${modifier}>}`);
    expect(list.querySelectorAll("kbd")).toHaveLength(0);
    await waitFor(() => {
      expect(within(list).getByText(threadHint)).toBeVisible();
    });
    expect(now() - pressedAt).toBeGreaterThanOrEqual(500);
    expect(searchHover).toBeVisible();
    expect(composer).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();

    const newChatButton = fastButton("New chat", list);
    await user.hover(newChatButton);
    const newChatHover = await screen.findByRole("tooltip", {
      name: `New chat ${hints[1]}`,
    });
    expect(newChatHover).toBeVisible();
    await user.keyboard(`{/${modifier}}`);
    await waitFor(() => {
      expect(list.querySelectorAll("kbd")).toHaveLength(0);
    });
    expect(newChatHover).toBeVisible();
    await user.unhover(newChatButton);
  },
);

test.each(platforms)(
  "Keep action shortcuts usable in a $platform browser, including the collapsed chat list",
  async ({ userAgent, modifier, hints }) => {
    context.mocks.browser.userAgent(userAgent);
    context.mocks.browser.matchMedia((query) => {
      return query === "(min-width: 48rem)";
    });
    const thread = chatListThread(1, "Keyboard shortcuts");
    const workspace = await installContinuityWorkspace(context, {
      caseId: 63,
      threads: [thread],
    });
    await setupPage({
      context,
      path: `/chats/${thread.id}`,
      auth: workspace.auth,
      featureSwitches,
    });
    const composer = await screen.findByRole("textbox", { name: "Message" });
    click(composer);
    const user = userEvent.setup();
    await user.keyboard(`{${modifier}>}{Shift>}o{/Shift}{/${modifier}}`);
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${CHAT_LIST_AGENT_ID}/chat`);
    });
    await user.keyboard(`{${modifier}>}b{/${modifier}}`);
    const showChatList = await screen.findByLabelText("Show chat list");
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
    await user.hover(showChatList);
    await expect(
      screen.findByRole("tooltip", { name: `Show chat list ${hints[2]}` }),
    ).resolves.toBeVisible();
    await user.keyboard(`{${modifier}>}b{/${modifier}}`);
    await screen.findByTestId("chat-list-column");
    await user.keyboard(`{${modifier}>}{Shift>}f{/Shift}{/${modifier}}`);
    const searchDialog = await screen.findByRole("dialog", {
      name: SEARCH_LABEL,
    });
    expect(
      within(searchDialog).getByPlaceholderText(SEARCH_LABEL),
    ).toHaveFocus();
  },
);

test("Hide thread hints when stable chat navigation is disabled and preserve action tooltips", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(min-width: 48rem)" || query === "(display-mode: standalone)"
    );
  });
  const workspace = await installContinuityWorkspace(context, {
    caseId: 62,
    threads: [chatListThread(1, "Thread hints")],
  });
  const response = context.mocks.deferred<void>();
  context.mocks.api(
    featureSwitchesContract.get,
    async ({ respond, withSignal }) => {
      await withSignal(response.promise);
      return respond(200, {
        switches: { [FeatureSwitchKey.StableChatThreadNavigation]: false },
        effectiveSwitches: {
          [FeatureSwitchKey.StableChatThreadNavigation]: false,
        },
      });
    },
  );
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth: workspace.auth,
    cachedFeatureSwitches: featureSwitches,
  });
  await screen.findByRole("textbox", { name: "Message" });
  const list = screen.getByTestId("chat-list-column");
  const user = userEvent.setup();
  await user.keyboard("{Control>}");
  await waitFor(() => {
    expect(within(list).getByText("Ctrl+1")).toBeVisible();
  });
  response.resolve(undefined);
  await waitFor(() => {
    expect(list.querySelectorAll("kbd")).toHaveLength(0);
  });
  await user.keyboard("{/Control}");
  await user.hover(fastButton("New chat", list));
  await expect(
    screen.findByRole("tooltip", { name: "New chat Ctrl+Shift+O" }),
  ).resolves.toBeVisible();
});
