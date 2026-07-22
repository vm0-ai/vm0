import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroWorkflowsCollectionContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pathname } from "../../../signals/location.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  AGENT_ID,
  OTHER_AGENT_ID,
  THREAD_ID,
  SUGGESTED_THREAD_ID,
  UNTITLED_THREAD_ID,
  OTHER_AGENT_THREAD_ID,
  linkByText,
  mockNavigatorUserAgent,
  mockIPadOSNavigator,
  mockOrgModelRoutes,
  mockAgent,
  mockThread,
  mockComposerThreadSnapshot,
  findComposerEditor,
  placeCaretAfterText,
  workflowSummary,
} from "./chat-composer-test-helpers.ts";

beforeEach(() => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
});

describe("chat composer models", () => {
  it("does not autofocus the agent chat composer on iPadOS", async () => {
    const restoreNavigator = mockIPadOSNavigator();
    try {
      mockOrgModelRoutes("kimi-k2.7-code");
      mockAgent();

      detachedSetupPage({
        context,
        path: `/agents/${AGENT_ID}/chat`,
      });

      await expect(findComposerEditor()).resolves.not.toHaveFocus();
    } finally {
      restoreNavigator();
    }
  });

  it("keeps the agent chat composer at three-line height", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const editor = await findComposerEditor();
    expect(editor).toHaveClass("min-h-[96px]");
    expect(editor).not.toHaveClass("min-h-[44px]");
  });

  it("uses the mobile single-line height in chat thread composers", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    mockThread();

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const editor = await findComposerEditor();
    expect(editor).toHaveClass("min-h-[44px]", "md:min-h-[96px]");
  });

  it("keeps the agent chat slash composer at three-line height", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, []);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const editor = await findComposerEditor();
    expect(editor).toHaveClass("min-h-[96px]");
    expect(editor).not.toHaveClass("min-h-[44px]");
  });

  it("uses the mobile single-line height in chat thread slash composers", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    mockThread();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, []);
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const editor = await findComposerEditor();
    expect(editor).toHaveClass("min-h-[44px]", "md:min-h-[96px]");
  });

  it("positions the slash workflow menu from the caret inside the viewport safe area", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        workflowSummary({
          name: "sales-research",
          displayName: "Sales Research",
          description: "Find account context before outreach",
          agentId: AGENT_ID,
        }),
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const root = document.createElement("div");
    root.id = "root";
    root.style.padding = "44px 6px 8px 10px";
    document.body.append(root);

    const originalVisualViewport = Object.getOwnPropertyDescriptor(
      window,
      "visualViewport",
    );
    const visualViewport = Object.assign(new EventTarget(), {
      height: 800,
      offsetLeft: 0,
      offsetTop: 100,
      onresize: null,
      onscroll: null,
      pageLeft: 0,
      pageTop: 100,
      scale: 1,
      width: 390,
    }) as VisualViewport;
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });

    const caretRect = new DOMRect(20, 300, 0, 24);
    const getClientRects = vi
      .spyOn(Range.prototype, "getClientRects")
      .mockReturnValue([caretRect] as unknown as DOMRectList);
    const getBoundingClientRect = vi
      .spyOn(Range.prototype, "getBoundingClientRect")
      .mockReturnValue(caretRect);

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/");

    const menu = await screen.findByTestId("slash-workflow-menu");
    const wrapper = menu.parentElement;
    if (!(wrapper instanceof HTMLElement)) {
      throw new Error("Slash workflow menu wrapper not found");
    }
    await waitFor(() => {
      expect(wrapper.style.transform).not.toContain("-200%");
    });
    const transform = wrapper.style.transform;
    const availableWidth = wrapper.style.getPropertyValue(
      "--radix-popper-available-width",
    );
    const availableHeight = wrapper.style.getPropertyValue(
      "--radix-popper-available-height",
    );

    getClientRects.mockRestore();
    getBoundingClientRect.mockRestore();
    root.remove();
    if (originalVisualViewport) {
      Object.defineProperty(window, "visualViewport", originalVisualViewport);
    } else {
      delete (window as { visualViewport?: VisualViewport }).visualViewport;
    }

    expect(transform).toBe("translate(20px, 392px)");
    expect(availableWidth).toBe("350px");
    expect(availableHeight).toBe("236px");
  });

  it("suggests current agent workflows from slash input and highlights inserted workflow tokens", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        workflowSummary({
          name: "sales-research",
          displayName: "Sales Research",
          description: "Find account context before outreach",
          agentId: AGENT_ID,
        }),
        workflowSummary({
          name: "support-escalation",
          displayName: "Support Escalation",
          description: "Summarize customer issues for handoff",
          agentId: AGENT_ID,
        }),
        workflowSummary({
          name: "deep-dive",
          displayName: "Deep Dive",
          description: "Seeded org workflow",
        }),
        workflowSummary({
          name: "other-agent-workflow",
          displayName: "Other Agent Workflow",
          description: "Attached somewhere else",
          agentId: OTHER_AGENT_ID,
        }),
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/");

    // Menu rows render the leading "/" as a separate accent span, so the row's
    // queryable text node is the bare workflow name (not the "/name" token).
    const salesSuggestion = await screen.findByText("sales-research");
    expect(salesSuggestion).toBeInTheDocument();
    expect(screen.getByText("support-escalation")).toBeInTheDocument();
    expect(screen.queryByText("deep-dive")).not.toBeInTheDocument();
    expect(screen.queryByText("other-agent-workflow")).not.toBeInTheDocument();
    // The menu renders in a Radix Popover portal (Floating UI handles
    // cross-browser placement), so it lives outside the composer element.
    const slashWorkflowMenu = screen.getByTestId("slash-workflow-menu");
    expect(slashWorkflowMenu).toBeInTheDocument();
    expect(slashWorkflowMenu).toHaveClass(
      "h-[min(16rem,var(--radix-popover-content-available-height))]",
      "md:h-[min(20rem,var(--radix-popover-content-available-height))]",
    );
    expect(slashWorkflowMenu).not.toHaveClass(
      "max-h-[min(16rem,var(--radix-popover-content-available-height))]",
      "md:max-h-[min(20rem,var(--radix-popover-content-available-height))]",
    );
    expect(slashWorkflowMenu).not.toHaveClass("max-h-80");

    await user.keyboard("sales");

    await waitFor(() => {
      expect(screen.queryByText("support-escalation")).not.toBeInTheDocument();
    });
    const matchedPrefix = screen.getByText("sales", { selector: "span" });
    expect(matchedPrefix).toHaveClass("text-primary/60");
    expect(screen.getByText("-research")).toBeInTheDocument();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(editor.textContent).toContain("/sales-research");
    });
    // The colored token is a real inline decoration in the same layer as the
    // text (no overlay), so it stays aligned when the composer scrolls.
    const highlightedWorkflow = screen
      .getAllByText("/sales-research")
      .find((element) => {
        return element.tagName.toLowerCase() === "span";
      });
    expect(highlightedWorkflow).toHaveClass("text-primary");
  });

  it("inserts a current-agent chat thread mention chip from @ suggestions", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    mockThread();
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: "My thread" },
      {
        id: SUGGESTED_THREAD_ID,
        agentId: AGENT_ID,
        title: "Project Alpha",
      },
      { id: UNTITLED_THREAD_ID, agentId: AGENT_ID, title: null },
      {
        id: OTHER_AGENT_THREAD_ID,
        agentId: OTHER_AGENT_ID,
        title: "Other Alpha",
      },
    ]);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ComposerChatThreadSuggestions]: true,
      },
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("Review @ALPHA");

    const menu = await screen.findByTestId("chat-thread-suggestion-menu");
    expect(within(menu).getByText("Project Alpha")).toBeInTheDocument();
    expect(within(menu).queryByText("Other Alpha")).not.toBeInTheDocument();
    expect(within(menu).queryByText("New chat")).not.toBeInTheDocument();

    await user.keyboard("{Enter}next");

    await waitFor(() => {
      expect(editor).toHaveTextContent("Review Project Alpha next");
    });
    const chip = editor.querySelector(
      `span[data-chat-thread-mention="${SUGGESTED_THREAD_ID}"]`,
    );
    expect(chip).toHaveTextContent("Project Alpha");
  });

  it("hides @ suggestions when no titled thread matches", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    mockThread();
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: "My thread" },
      {
        id: SUGGESTED_THREAD_ID,
        agentId: AGENT_ID,
        title: "Project Beta",
      },
      { id: UNTITLED_THREAD_ID, agentId: AGENT_ID, title: null },
    ]);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ComposerChatThreadSuggestions]: true,
      },
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("@beta");

    const menu = await screen.findByTestId("chat-thread-suggestion-menu");
    expect(within(menu).getByText("Project Beta")).toBeInTheDocument();
    expect(within(menu).queryByText("New chat")).not.toBeInTheDocument();

    await user.keyboard("{Backspace>4/}alpha");

    await waitFor(() => {
      expect(
        screen.queryByTestId("chat-thread-suggestion-menu"),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps @ chat thread suggestions behind the feature switch", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    mockThread();
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: "My thread" },
      {
        id: SUGGESTED_THREAD_ID,
        agentId: AGENT_ID,
        title: "Project Alpha",
      },
    ]);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ComposerChatThreadSuggestions]: false,
      },
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("@alpha");

    await waitFor(() => {
      expect(editor).toHaveTextContent("@alpha");
      expect(
        screen.queryByTestId("chat-thread-suggestion-menu"),
      ).not.toBeInTheDocument();
    });
  });

  it("shows a workflow created in the current chat without a page refresh", async () => {
    const user = userEvent.setup({ delay: null });
    let workflows: ReturnType<typeof workflowSummary>[] = [];
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    mockThread();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, workflows);
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription(
          `chatThreadWorkflowsChanged:${THREAD_ID}`,
        ),
      ).toBeTruthy();
    });
    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/");
    await expect(
      screen.findByText("No matching workflows"),
    ).resolves.toBeInTheDocument();

    workflows = [
      workflowSummary({
        name: "new-chat-workflow",
        displayName: "New Chat Workflow",
        description: "Created by the current chat run",
        agentId: AGENT_ID,
      }),
    ];
    act(() => {
      context.mocks.ably.trigger(
        `chatThreadWorkflowsChanged:${THREAD_ID}`,
        null,
      );
    });

    await expect(
      screen.findByText("new-chat-workflow"),
    ).resolves.toBeInTheDocument();
  });

  it("closes the slash workflow menu when focus leaves the composer input", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        workflowSummary({
          name: "sales-research",
          displayName: "Sales Research",
          description: "Find account context before outreach",
          agentId: AGENT_ID,
        }),
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/");
    await expect(
      screen.findByTestId("slash-workflow-menu"),
    ).resolves.toBeInTheDocument();

    await user.click(screen.getByLabelText("Template"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("slash-workflow-menu"),
      ).not.toBeInTheDocument();
    });
    expect(editor).not.toHaveFocus();
  });

  it("closes the slash workflow menu with Escape after a non-empty query", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        workflowSummary({
          name: "sales-research",
          displayName: "Sales Research",
          description: "Find account context before outreach",
          agentId: AGENT_ID,
        }),
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/sales");
    await expect(
      screen.findByTestId("slash-workflow-menu"),
    ).resolves.toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(
        screen.queryByTestId("slash-workflow-menu"),
      ).not.toBeInTheDocument();
    });
    expect(editor).toHaveTextContent("/sales");
    expect(editor).toHaveFocus();
  });

  it("does not suggest workflows that are not attached to the current agent", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        workflowSummary({
          name: "deep-dive",
          displayName: "Deep Dive",
          description: "Seeded org workflow",
        }),
        workflowSummary({
          name: "other-agent-workflow",
          displayName: "Other Agent Workflow",
          description: null,
          agentId: OTHER_AGENT_ID,
        }),
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/");

    await waitFor(() => {
      expect(screen.queryByText("deep-dive")).not.toBeInTheDocument();
    });
    expect(editor.textContent).toContain("/");
  });

  it("links to the workflows page from the slash workflow menu footer", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        workflowSummary({
          name: "deep-dive",
          displayName: "Deep Dive",
          description: "Seeded org workflow",
        }),
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/");

    await expect(
      screen.findByText("No matching workflows"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("deep-dive")).not.toBeInTheDocument();
    const link = linkByText("View all workflows");
    expect(link).toHaveAttribute("href", "/workflows");
    expect(link.parentElement).toHaveClass("shrink-0", "border-t");
    await user.click(link);
    expect(pathname()).toBe("/workflows");
  });

  it("scrolls the slash workflow picker with keyboard selection", async () => {
    const user = userEvent.setup({ delay: null });
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    mockOrgModelRoutes("kimi-k2.7-code");
    const customWorkflows = Array.from({ length: 12 }, (_, index) => {
      return `custom-workflow-${index + 1}`;
    });
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(
        200,
        customWorkflows.map((name) => {
          return workflowSummary({
            name,
            displayName: null,
            description: null,
            agentId: AGENT_ID,
          });
        }),
      );
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/");
    await expect(
      screen.findByText("custom-workflow-1"),
    ).resolves.toBeInTheDocument();

    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    });
  });

  it("keeps Shift+Enter and Mac Ctrl+A/Ctrl+E scoped to composer lines", async () => {
    const restoreUserAgent = mockNavigatorUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    );
    try {
      const user = userEvent.setup({ delay: null });
      mockOrgModelRoutes("kimi-k2.7-code");
      mockAgent();
      context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
        return respond(200, []);
      });

      detachedSetupPage({
        context,
        path: `/agents/${AGENT_ID}/chat`,
      });

      const editor = await findComposerEditor();
      await user.click(editor);
      await user.keyboard("first line{Shift>}{Enter}{/Shift}second line");
      await user.keyboard("{Control>}a{/Control}X");

      await waitFor(() => {
        expect(editor.innerHTML).toContain(
          "<p>first line</p><p>Xsecond line</p>",
        );
        expect(editor.innerHTML).not.toContain("<br>");
      });

      placeCaretAfterText(editor, "Xsecond line");
      await user.keyboard("{Shift>}{Enter}{/Shift}third line");
      placeCaretAfterText(editor, "Xsecond line");
      await user.keyboard("{Control>}e{/Control}Y");

      await waitFor(() => {
        expect(editor.innerHTML).toContain(
          "<p>first line</p><p>Xsecond lineY</p><p>third line</p>",
        );
        expect(editor.innerHTML).not.toContain("<br>");
      });
    } finally {
      restoreUserAgent();
    }
  });
});
