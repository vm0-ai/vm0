import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { zeroWorkflowsCollectionContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pathname } from "../../../signals/location.ts";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
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
      featureSwitches: {
        [FeatureSwitchKey.ComposerSkillSubstringSearch]: true,
      },
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

    await user.keyboard("ReSeArCh");

    await waitFor(() => {
      expect(screen.queryByText("support-escalation")).not.toBeInTheDocument();
    });
    const matchedSubstring = screen.getByText("research", {
      selector: "span",
    });
    expect(matchedSubstring).toHaveClass("text-primary/60");

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

  it("keeps slash skill substring matching behind the feature switch", async () => {
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
          name: "research-assistant",
          displayName: "Research Assistant",
          description: "Research a topic from the beginning",
          agentId: AGENT_ID,
        }),
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.ComposerSkillSubstringSearch]: false,
      },
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/ReSeArCh");

    const slashWorkflowMenu = await screen.findByTestId("slash-workflow-menu");
    expect(slashWorkflowMenu).toHaveTextContent("/research-assistant");
    expect(slashWorkflowMenu).not.toHaveTextContent("/sales-research");
  });

  it("prioritizes prefix matches in slash skill substring search", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        workflowSummary({
          name: "dummy-pr-to-release",
          displayName: "Dummy PR to Release",
          description: null,
          agentId: AGENT_ID,
        }),
        workflowSummary({
          name: "release-production",
          displayName: "Release Production",
          description: null,
          agentId: AGENT_ID,
        }),
        workflowSummary({
          name: "prepare-release-notes",
          displayName: "Prepare Release Notes",
          description: null,
          agentId: AGENT_ID,
        }),
        workflowSummary({
          name: "release-staging",
          displayName: "Release Staging",
          description: null,
          agentId: AGENT_ID,
        }),
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.ComposerSkillSubstringSearch]: true,
      },
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/ReLeAsE");

    const slashWorkflowMenu = await screen.findByTestId("slash-workflow-menu");
    expect(
      queryAllByRoleFast("button", slashWorkflowMenu).map((option) => {
        return option.textContent;
      }),
    ).toStrictEqual([
      "/release-production",
      "/release-staging",
      "/dummy-pr-to-release",
      "/prepare-release-notes",
    ]);

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(editor.textContent).toContain("/release-production");
    });
  });

  it("does not highlight workflow names inside URLs", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        workflowSummary({
          name: "pr-review",
          displayName: "PR Review",
          description: "Review a pull request",
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
    await user.keyboard("https://www.vm0.ai/en/use-cases/pr-review");

    expect(editor).toHaveTextContent(
      "https://www.vm0.ai/en/use-cases/pr-review",
    );
    expect(editor.querySelector("span.text-primary")).not.toBeInTheDocument();
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

  it("reloads workflow suggestions and highlights without remounting the composer", async () => {
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
    await expect(findComposerEditor()).resolves.toBe(editor);

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(editor).toHaveTextContent("/new-chat-workflow");
    });
    const highlightedWorkflow = screen
      .getAllByText("/new-chat-workflow")
      .find((element) => {
        return element.tagName.toLowerCase() === "span";
      });
    expect(highlightedWorkflow).toHaveClass("text-primary");
  });

  it("keeps the latest workflow highlights when split-pane reloads resolve out of order", async () => {
    const user = userEvent.setup({ delay: null });
    const staleRequestsStarted = context.mocks.deferred<void>();
    const releaseStaleRequests = context.mocks.deferred<void>();
    const freshRequestsStarted = context.mocks.deferred<void>();
    const barrierRequestsStarted = context.mocks.deferred<void>();
    const releaseBarrierRequests = context.mocks.deferred<void>();
    const latestWorkflow = workflowSummary({
      name: "new-split-workflow",
      displayName: "New Split Workflow",
      description: "Created by the right chat run",
      agentId: AGENT_ID,
    });
    let reloadPhase: "initial" | "stale" | "fresh" | "barrier" = "initial";
    let staleRequestCount = 0;
    let freshRequestCount = 0;
    let barrierRequestCount = 0;
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    mockThread();
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: "Left thread" },
      { id: SUGGESTED_THREAD_ID, agentId: AGENT_ID, title: "Right thread" },
    ]);
    context.mocks.api(
      zeroWorkflowsCollectionContract.list,
      async ({ respond }) => {
        if (reloadPhase === "stale") {
          staleRequestCount += 1;
          if (staleRequestCount === 2) {
            staleRequestsStarted.resolve();
          }
          await releaseStaleRequests.promise;
          return respond(200, []);
        }
        if (reloadPhase === "fresh") {
          freshRequestCount += 1;
          if (freshRequestCount === 2) {
            freshRequestsStarted.resolve();
          }
          return respond(200, [latestWorkflow]);
        }
        if (reloadPhase === "barrier") {
          barrierRequestCount += 1;
          if (barrierRequestCount === 4) {
            barrierRequestsStarted.resolve();
          }
          await releaseBarrierRequests.promise;
          return respond(200, [latestWorkflow]);
        }
        return respond(200, []);
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}?sidebar=${SUGGESTED_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription(
          `chatThreadWorkflowsChanged:${THREAD_ID}`,
        ),
      ).toBeTruthy();
      expect(
        context.mocks.ably.hasSubscription(
          `chatThreadWorkflowsChanged:${SUGGESTED_THREAD_ID}`,
        ),
      ).toBeTruthy();
    });
    const threadRegions = await screen.findAllByLabelText("Chat thread");
    expect(threadRegions).toHaveLength(2);
    const leftThread = threadRegions[0];
    const rightThread = threadRegions[1];
    if (!leftThread || !rightThread) {
      throw new Error("Split chat threads not found");
    }
    const leftEditor = await within(leftThread).findByRole("textbox", {
      name: "Message",
    });
    const rightEditor = await within(rightThread).findByRole("textbox", {
      name: "Message",
    });
    await user.click(leftEditor);
    await user.keyboard("/");
    await expect(
      screen.findByText("No matching workflows"),
    ).resolves.toBeInTheDocument();

    reloadPhase = "stale";
    act(() => {
      context.mocks.ably.trigger(
        `chatThreadWorkflowsChanged:${SUGGESTED_THREAD_ID}`,
        null,
      );
    });
    await staleRequestsStarted.promise;

    reloadPhase = "fresh";
    act(() => {
      context.mocks.ably.trigger(
        `chatThreadWorkflowsChanged:${THREAD_ID}`,
        null,
      );
    });
    await freshRequestsStarted.promise;

    await expect(
      screen.findByText("new-split-workflow"),
    ).resolves.toBeInTheDocument();
    expect(within(leftThread).getByRole("textbox", { name: "Message" })).toBe(
      leftEditor,
    );
    expect(within(rightThread).getByRole("textbox", { name: "Message" })).toBe(
      rightEditor,
    );

    reloadPhase = "barrier";
    act(() => {
      context.mocks.ably.trigger(
        `chatThreadWorkflowsChanged:${THREAD_ID}`,
        null,
      );
    });
    await waitFor(() => {
      expect(barrierRequestCount).toBe(2);
    });

    act(() => {
      releaseStaleRequests.resolve();
      context.mocks.ably.trigger(
        `chatThreadWorkflowsChanged:${SUGGESTED_THREAD_ID}`,
        null,
      );
    });
    await barrierRequestsStarted.promise;

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(leftEditor).toHaveTextContent("/new-split-workflow");
    });
    const highlightedWorkflow = within(leftEditor)
      .getAllByText("/new-split-workflow")
      .find((element) => {
        return element.tagName.toLowerCase() === "span";
      });
    expect(highlightedWorkflow).toHaveClass("text-primary");
    releaseBarrierRequests.resolve();
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
