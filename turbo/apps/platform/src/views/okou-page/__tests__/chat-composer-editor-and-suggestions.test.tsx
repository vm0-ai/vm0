import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
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
  mockOrgModelRoutes,
  mockAgent,
  mockThread,
  mockComposerThreadSnapshot,
  findComposerEditor,
  placeCaretAfterText,
  workflowSummary,
} from "./chat-composer-test-helpers.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import { createMockAgentResponse } from "../../../mocks/handlers/api-agents.ts";

// The composer editor is mounted on first paint and mounted again once page
// bootstrap settles, so an element captured too early is detached by the time a
// test asserts on it. Read whichever editor is currently mounted.
function mountedComposer(): HTMLElement {
  const editor = document.querySelector(
    '.zero-composer [contenteditable="true"]',
  );
  if (!(editor instanceof HTMLElement)) {
    throw new Error("Composer editor is not mounted");
  }
  return editor;
}

function mountedComposerText(): string {
  return mountedComposer().textContent ?? "";
}

function suggestionAgent({
  agentId,
  displayName,
  avatarUrl = null,
  visibility = "public",
}: {
  readonly agentId: string;
  readonly displayName: string;
  readonly avatarUrl?: string | null;
  readonly visibility?: "public" | "private";
}): AgentResponse {
  return createMockAgentResponse({
    agentId,
    displayName,
    avatarUrl,
    visibility,
  });
}

beforeEach(() => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
});

describe("chat composer models", () => {
  it("does not autofocus the agent chat composer on iPadOS", async () => {
    context.mocks.browser.userAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) " +
        "AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    );
    context.mocks.browser.platform("MacIntel");
    context.mocks.browser.maxTouchPoints(5);
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await expect(findComposerEditor()).resolves.not.toHaveFocus();
  });

  it("keeps the agent chat composer at three-line height", async () => {
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const editor = await findComposerEditor();
    expect(editor).toHaveClass("min-h-[96px]");
    expect(editor).not.toHaveClass("min-h-[68px]");
  });

  it("uses the mobile two-line height in chat thread composers", async () => {
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockThread();

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const editor = await findComposerEditor();
    expect(editor).toHaveClass("min-h-[68px]", "md:min-h-[96px]");
  });

  it("keeps the agent chat slash composer at three-line height", async () => {
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
      return respond(200, []);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const editor = await findComposerEditor();
    expect(editor).toHaveClass("min-h-[96px]");
    expect(editor).not.toHaveClass("min-h-[68px]");
  });

  it("uses the mobile two-line height in chat thread slash composers", async () => {
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockThread();
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
      return respond(200, []);
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const editor = await findComposerEditor();
    expect(editor).toHaveClass("min-h-[68px]", "md:min-h-[96px]");
  });

  it("hides the placeholder for whitespace without enabling send", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const editor = await findComposerEditor();
    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getByLabelText("Send")).toBeDisabled();

    await user.click(editor);
    await user.keyboard(" ");

    await waitFor(() => {
      expect(screen.queryByText(PLACEHOLDER)).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText("Send")).toBeDisabled();
  });

  it("selects from the slash workflow menu with a visual viewport offset", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
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
    context.signal.addEventListener(
      "abort",
      () => {
        root.remove();
      },
      { once: true },
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
    vi.stubGlobal("visualViewport", visualViewport);

    const caretRect = new DOMRect(20, 300, 0, 24);
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      caretRect,
    ] as unknown as DOMRectList);
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      caretRect,
    );

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/");

    await expect(
      screen.findByText("sales-research"),
    ).resolves.toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(mountedComposerText()).toContain("/sales-research");
    });
  });

  it("suggests current agent workflows from slash input and highlights inserted workflow tokens", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
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
    // The menu renders in a Base UI Popover portal (Floating UI handles
    // cross-browser placement), so it lives outside the composer element.
    expect(screen.getByTestId("slash-workflow-menu")).toBeInTheDocument();

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
      expect(mountedComposerText()).toContain("/sales-research");
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

  it("matches slash skills by substring while prioritizing prefixes", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
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
      expect(mountedComposerText()).toContain("/release-production");
    });
  });

  it("does not highlight workflow names inside URLs", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
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

    expect(mountedComposerText()).toContain(
      "https://www.vm0.ai/en/use-cases/pr-review",
    );
    expect(editor.querySelector("span.text-primary")).not.toBeInTheDocument();
  });

  it("suggests threads from every agent with aligned agent avatars", async () => {
    const currentAgentAvatarUrl =
      "https://example.com/current-agent-avatar.png";
    const otherAgentAvatarUrl = "https://example.com/other-agent-avatar.png";
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockThread();
    context.mocks.data.agents([
      suggestionAgent({
        agentId: AGENT_ID,
        displayName: "Scout",
        avatarUrl: currentAgentAvatarUrl,
      }),
      suggestionAgent({
        agentId: OTHER_AGENT_ID,
        displayName: "Reviewer",
        avatarUrl: otherAgentAvatarUrl,
      }),
    ]);
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: "My thread" },
      {
        id: SUGGESTED_THREAD_ID,
        agentId: AGENT_ID,
        title: "Project Alpha",
      },
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
    await user.keyboard("Review @alpha");

    const menu = await screen.findByTestId("chat-thread-suggestion-menu");
    const threadButtons = queryAllByRoleFast("button", menu);
    const currentAgentThread = threadButtons.find((button) => {
      return button.textContent === "Project Alpha";
    });
    const otherAgentThread = threadButtons.find((button) => {
      return button.textContent === "Other Alpha";
    });
    if (!currentAgentThread || !otherAgentThread) {
      throw new Error("Expected matching chat thread suggestions");
    }
    const currentAgentThreadAvatar = currentAgentThread.querySelector("img");
    const otherAgentThreadAvatar = otherAgentThread.querySelector("img");
    expect(currentAgentThread).toHaveClass("gap-2");
    expect(otherAgentThread).toHaveClass("gap-2");
    expect(currentAgentThreadAvatar).toHaveAttribute(
      "src",
      currentAgentAvatarUrl,
    );
    expect(currentAgentThreadAvatar).toHaveClass("h-5", "w-5");
    expect(otherAgentThreadAvatar).toHaveAttribute("src", otherAgentAvatarUrl);
    expect(otherAgentThreadAvatar).toHaveClass("h-5", "w-5");
    // Avatars are transparent, so any background fill shows through as a gray
    // disc behind the face.
    expect(currentAgentThreadAvatar).not.toHaveClass("bg-muted");
    expect(otherAgentThreadAvatar).not.toHaveClass("bg-muted");

    await user.click(otherAgentThread);

    await waitFor(() => {
      expect(mountedComposerText()).toContain("Review Other Alpha");
    });
    expect(
      editor.querySelector(
        `span[data-chat-thread-mention="${OTHER_AGENT_THREAD_ID}"]`,
      ),
    ).toHaveTextContent("Other Alpha");
  });

  it("suggests agents above chat threads and inserts an agent item", async () => {
    const alphaAgentId = "a1000000-0000-4000-a000-000000000001";
    const betaAgentId = "a1000000-0000-4000-a000-000000000002";
    const gammaAgentId = "a1000000-0000-4000-a000-000000000003";
    const zetaAgentId = "a1000000-0000-4000-a000-000000000004";
    const privateAgentId = "a1000000-0000-4000-a000-000000000005";
    const zetaAvatarUrl = "https://example.com/zeta-avatar.png";
    const draftPatches: Record<string, unknown>[] = [];
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockThread();
    context.mocks.data.agents([
      suggestionAgent({ agentId: AGENT_ID, displayName: "Scout" }),
      suggestionAgent({
        agentId: alphaAgentId,
        displayName: "Alpha Agent",
        avatarUrl: "preset:0",
      }),
      suggestionAgent({
        agentId: privateAgentId,
        displayName: "Private Agent",
        visibility: "private",
      }),
      suggestionAgent({
        agentId: betaAgentId,
        displayName: "Beta Agent",
        avatarUrl: "preset:1",
      }),
      suggestionAgent({
        agentId: gammaAgentId,
        displayName: "Gamma Agent",
        avatarUrl: "preset:2",
      }),
      suggestionAgent({
        agentId: zetaAgentId,
        displayName: "Zeta Agent",
        avatarUrl: zetaAvatarUrl,
      }),
    ]);
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: null },
      {
        id: SUGGESTED_THREAD_ID,
        agentId: AGENT_ID,
        title: "Project Alpha",
      },
    ]);
    context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
      draftPatches.push(body as Record<string, unknown>);
      return respond(204);
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("@");

    const menu = await screen.findByTestId("chat-thread-suggestion-menu");
    expect(
      queryAllByRoleFast("button", menu).map((button) => {
        return button.textContent;
      }),
    ).toStrictEqual([
      "Alpha Agent",
      "Private Agent",
      "Beta Agent",
      "Project Alpha",
    ]);
    expect(within(menu).queryByText("Scout")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Gamma Agent")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Zeta Agent")).not.toBeInTheDocument();

    await user.keyboard("private");
    await waitFor(() => {
      const filteredMenu = screen.getByTestId("chat-thread-suggestion-menu");
      expect(
        within(filteredMenu).getByText("Private Agent"),
      ).toBeInTheDocument();
      expect(
        within(filteredMenu).queryByText("Project Alpha"),
      ).not.toBeInTheDocument();
    });
    await user.keyboard("{Backspace>7/}zeta");
    await waitFor(() => {
      const filteredMenu = screen.getByTestId("chat-thread-suggestion-menu");
      expect(within(filteredMenu).getByText("Zeta Agent")).toBeInTheDocument();
      expect(
        within(filteredMenu).queryByText("Project Alpha"),
      ).not.toBeInTheDocument();
    });
    // Avatars are transparent, so any background fill shows through as a gray
    // disc behind the face.
    const zetaAgentAvatar = screen
      .getByTestId("chat-thread-suggestion-menu")
      .querySelector("img");
    expect(zetaAgentAvatar).toHaveAttribute("src", zetaAvatarUrl);
    expect(zetaAgentAvatar).not.toHaveClass("bg-muted");
    await user.keyboard("{Enter}");

    const item = editor.querySelector(
      `span[data-agent-mention="${zetaAgentId}"]`,
    );
    expect(item).toHaveTextContent("Zeta Agent");
    expect(item?.querySelector("img")).toHaveAttribute("src", zetaAvatarUrl);
    await waitFor(() => {
      expect(draftPatches).toContainEqual(
        expect.objectContaining({
          draftUserMessage: expect.objectContaining({
            version: 1,
            parts: expect.arrayContaining([
              {
                type: "agent",
                agentId: zetaAgentId,
                nameSnapshot: "Zeta Agent",
              },
            ]),
          }),
        }),
      );
    });
  });

  it("restores a persisted agent item with its current avatar", async () => {
    const mentionedAgentId = "a1000000-0000-4000-a000-000000000006";
    const mentionedAgentAvatarUrl =
      "https://example.com/restored-agent-avatar.png";
    const mention = `[Restored Agent](/agents/${mentionedAgentId}/chat)`;
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockThread();
    context.mocks.data.agents([
      suggestionAgent({ agentId: AGENT_ID, displayName: "Scout" }),
      suggestionAgent({
        agentId: mentionedAgentId,
        displayName: "Restored Agent",
        avatarUrl: mentionedAgentAvatarUrl,
      }),
    ]);
    context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
      return respond(200, {
        draftUserMessage: {
          version: 1,
          parts: [{ type: "text", text: mention }],
        },
        draftAttachments: null,
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const editor = await findComposerEditor();
    await waitFor(() => {
      const item = editor.querySelector(
        `span[data-agent-mention="${mentionedAgentId}"]`,
      );
      expect(item).toHaveTextContent("Restored Agent");
      expect(item?.querySelector("img")).toHaveAttribute(
        "src",
        mentionedAgentAvatarUrl,
      );
    });
  });

  it("hides @ suggestions when no titled thread matches", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-fable-5");
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
    const reloadWorkflowsRequested = context.mocks.deferred<void>();
    const releaseReloadWorkflows = context.mocks.deferred<void>();
    const reloadedWorkflow = workflowSummary({
      name: "new-chat-workflow",
      displayName: "New Chat Workflow",
      description: "Created by the current chat run",
      agentId: AGENT_ID,
    });
    let workflowPhase: "initial" | "reloaded" = "initial";
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockThread();
    context.mocks.api(workflowsCollectionContract.list, async ({ respond }) => {
      if (workflowPhase === "initial") {
        return respond(200, []);
      }
      if (!reloadWorkflowsRequested.settled()) {
        reloadWorkflowsRequested.resolve();
      }
      await releaseReloadWorkflows.promise;
      return respond(200, [reloadedWorkflow]);
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
      expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
    });
    const thread = await screen.findByLabelText("Chat thread");
    const initialEditor = await within(thread).findByRole("textbox", {
      name: "Message",
    });

    workflowPhase = "reloaded";
    act(() => {
      context.mocks.ably.trigger(
        `chatThreadWorkflowsChanged:${THREAD_ID}`,
        null,
      );
    });
    await reloadWorkflowsRequested.promise;
    releaseReloadWorkflows.resolve();

    await expect(findComposerEditor()).resolves.toBe(initialEditor);
    await user.click(initialEditor);
    await user.keyboard("/");
    await expect(
      screen.findByText("new-chat-workflow"),
    ).resolves.toBeInTheDocument();
    await expect(findComposerEditor()).resolves.toBe(initialEditor);

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(mountedComposerText()).toContain("/new-chat-workflow");
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
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockThread();
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: "Left thread" },
      { id: SUGGESTED_THREAD_ID, agentId: AGENT_ID, title: "Right thread" },
    ]);
    context.mocks.api(workflowsCollectionContract.list, async ({ respond }) => {
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
    });

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
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
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
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
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
    expect(mountedComposerText()).toContain("/sales");
    expect(mountedComposer()).toHaveFocus();
  });

  it("does not suggest workflows that are not attached to the current agent", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
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
    expect(mountedComposerText()).toContain("/");
  });

  it("links to the workflows page from the slash workflow menu footer", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
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
    const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    mockOrgModelRoutes("claude-fable-5");
    const customWorkflows = Array.from({ length: 12 }, (_, index) => {
      return `custom-workflow-${index + 1}`;
    });
    mockAgent();
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
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
    context.mocks.browser.userAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    );
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
      return respond(200, []);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await findComposerEditor();
    // Select-all before typing so a retry against a freshly mounted editor
    // replaces the draft instead of appending to it.
    await waitFor(async () => {
      const composer = mountedComposer();
      await user.click(composer);
      await user.keyboard("{Control>}a{/Control}");
      await user.keyboard("first line{Shift>}{Enter}{/Shift}second line");
      if (
        !mountedComposer().innerHTML.includes(
          "<p>first line</p><p>second line</p>",
        )
      ) {
        throw new Error("Composer did not accept the typed lines");
      }
    });
    await user.keyboard("{Control>}a{/Control}X");

    await waitFor(() => {
      expect(mountedComposer().innerHTML).toContain(
        "<p>first line</p><p>Xsecond line</p>",
      );
      expect(mountedComposer().innerHTML).not.toContain("<br>");
    });

    placeCaretAfterText(mountedComposer(), "Xsecond line");
    await user.keyboard("{Shift>}{Enter}{/Shift}third line");
    placeCaretAfterText(mountedComposer(), "Xsecond line");
    await user.keyboard("{Control>}e{/Control}Y");

    await waitFor(() => {
      expect(mountedComposer().innerHTML).toContain(
        "<p>first line</p><p>Xsecond lineY</p><p>third line</p>",
      );
      expect(mountedComposer().innerHTML).not.toContain("<br>");
    });
  });
});
