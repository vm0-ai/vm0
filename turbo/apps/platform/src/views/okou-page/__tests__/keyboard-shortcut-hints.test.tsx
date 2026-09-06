import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
const SEARCH_LABEL = "Search chats, messages, workflows, and artifacts...";

function shortcutHintLabels(): string[] {
  return screen
    .queryAllByRole("tooltip", { hidden: true })
    .flatMap((tooltip) => {
      return [...tooltip.querySelectorAll("kbd")].map((key) => {
        return key.textContent ?? "";
      });
    })
    .sort();
}

const platforms = [
  {
    platform: "Mac",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36",
    modifier: "Meta",
    hints: ["⌘⇧F", "⌘⇧O", "⌘B"],
  },
  {
    platform: "Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    modifier: "Control",
    hints: ["Ctrl+Shift+F", "Ctrl+Shift+O", "Ctrl+B"],
  },
] as const;

test.each(platforms)(
  "Show one hint panel after a 500 ms hold in a $platform browser and switch cleanly between hover labels",
  async ({ userAgent, modifier, hints }) => {
    context.mocks.browser.userAgent(userAgent);
    context.mocks.browser.matchMedia((query) => {
      return query === "(min-width: 48rem)";
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
      name: "Search workspace",
    });
    const pressedAt = now();
    await user.keyboard(`{${modifier}>}`);
    expect(shortcutHintLabels()).toStrictEqual([]);
    await waitFor(() => {
      expect(shortcutHintLabels()).toStrictEqual([...hints].sort());
    });
    expect(now() - pressedAt).toBeGreaterThanOrEqual(500);
    expect(searchHover).not.toBeVisible();
    const hintPanels = screen
      .getAllByRole("tooltip", { hidden: true })
      .filter((tooltip) => {
        return tooltip.querySelector("kbd") !== null;
      });
    expect(hintPanels).toHaveLength(1);
    expect(hintPanels[0]).toHaveTextContent("Search workspace");
    expect(hintPanels[0]).toHaveTextContent("New chat");
    expect(hintPanels[0]).toHaveTextContent("Hide chat list");
    expect(composer).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Browser tab-number shortcuts stay reserved for the browser.
    expect(list.querySelectorAll("kbd")).toHaveLength(0);

    const newChatButton = fastButton("New chat", list);
    await user.hover(newChatButton);
    expect(screen.queryByRole("tooltip", { name: "New chat" })).toBeNull();
    await user.keyboard(`{/${modifier}}`);
    await waitFor(() => {
      expect(shortcutHintLabels()).toStrictEqual([]);
    });
    await expect(
      screen.findByRole("tooltip", { name: "New chat" }),
    ).resolves.toBeVisible();
    await user.unhover(newChatButton);
  },
);

test.each(platforms)(
  "Keep shortcuts usable with grouped hints in a $platform browser, including the collapsed chat list",
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
    await screen.findByLabelText("Show chat list");
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
    await user.keyboard(`{${modifier}>}`);
    await waitFor(() => {
      expect(shortcutHintLabels()).toStrictEqual([hints[2]]);
    });
    await user.keyboard(`b{/${modifier}}`);
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

test("Cancel brief holds and dismiss global hints on release, blur, and visibility loss", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  const visibility = context.mocks.browser.visibilityState("visible");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 61,
    threads: [],
  });
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth: workspace.auth,
    featureSwitches,
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  click(composer);
  const user = userEvent.setup();
  await user.keyboard("{Control>}{/Control}");
  expect(shortcutHintLabels()).toStrictEqual([]);
  const pressedAt = now();
  await user.keyboard("{Control>}");
  await waitFor(() => {
    expect(shortcutHintLabels()).toHaveLength(3);
  });
  expect(now() - pressedAt).toBeGreaterThanOrEqual(500);
  fireEvent.blur(window);
  await waitFor(() => {
    expect(shortcutHintLabels()).toStrictEqual([]);
  });
  await user.keyboard("{/Control}{Control>}");
  await waitFor(() => {
    expect(shortcutHintLabels()).toHaveLength(3);
  });
  visibility.changeTo("hidden");
  await waitFor(() => {
    expect(shortcutHintLabels()).toStrictEqual([]);
  });
  visibility.changeTo("visible");
  await user.keyboard("{/Control}{Control>}");
  await waitFor(() => {
    expect(shortcutHintLabels()).toHaveLength(3);
  });
  await user.keyboard("{/Control}");
  await waitFor(() => {
    expect(shortcutHintLabels()).toStrictEqual([]);
  });
  expect(composer).toHaveFocus();
});

test("Hide active hints when stable chat navigation is disabled and preserve hover labels", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  const workspace = await installContinuityWorkspace(context, {
    caseId: 62,
    threads: [],
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
  const user = userEvent.setup();
  await user.keyboard("{Control>}");
  await waitFor(() => {
    expect(shortcutHintLabels()).toHaveLength(3);
  });
  response.resolve(undefined);
  await waitFor(() => {
    expect(shortcutHintLabels()).toStrictEqual([]);
  });
  await user.keyboard("{/Control}");
  const list = screen.getByTestId("chat-list-column");
  await user.hover(fastButton("New chat", list));
  await expect(
    screen.findByRole("tooltip", { name: "New chat" }),
  ).resolves.toBeVisible();
});
