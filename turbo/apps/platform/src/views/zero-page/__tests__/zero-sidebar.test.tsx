import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadUnpinContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createMockAutomationView } from "../../../mocks/handlers/automations-store.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { splitChatThreadListResponse } from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const SUPPORT_AGENT_ID = "c0000000-0000-4000-a000-000000000003";
const EXISTING_THREAD_ID = "b0000000-0000-4000-a000-000000000001";
const INCIDENT_THREAD_ID = "b0000000-0000-4000-a000-000000000002";
const AUTOMATION_THREAD_ID = "b0000000-0000-4000-a000-000000000003";
const ARCHIVED_THREAD_ID = "b0000000-0000-4000-a000-000000000004";

type SidebarThread = Parameters<typeof splitChatThreadListResponse>[0][number];

function prepareDefaultAgent(): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
}

function prepareAgentTeam(): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: RESEARCH_AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Research Agent",
      description: null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_2",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: SUPPORT_AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Support Agent",
      description: null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_3",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
    const displayNameById: Record<string, string> = {
      [AGENT_ID]: "Zero",
      [RESEARCH_AGENT_ID]: "Research Agent",
      [SUPPORT_AGENT_ID]: "Support Agent",
    };
    return respond(200, {
      agentId: params.id,
      ownerId: "test-user-123",
      description: null,
      displayName: displayNameById[params.id] ?? null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    });
  });
}

function createThread(
  id: string,
  title: string,
  overrides: Partial<SidebarThread> = {},
): SidebarThread {
  return {
    id,
    title,
    agent: { id: AGENT_ID, avatarUrl: null },
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-03-10T00:00:00Z",
    running: false,
    pinnedAt: null,
    ...overrides,
  };
}

function menuItemByText(text: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function sidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Sidebar" });
}

function threadRowByTitle(title: string): HTMLElement {
  const link = queryAllByRoleFast("link", sidebar()).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === title;
  });
  if (!link) {
    throw new Error(`${title} thread link not found`);
  }
  const row = link.parentElement;
  if (!row) {
    throw new Error(`${title} thread row not found`);
  }
  return row;
}

function openThreadMenu(title: string): void {
  click(
    within(threadRowByTitle(title)).getByTestId("chat-thread-menu-trigger"),
  );
}

function mockSidebarThreadStory(
  firstPageThreads: SidebarThread[],
  extraThreads: SidebarThread[] = [],
): {
  threads: SidebarThread[];
} {
  let threads = [...firstPageThreads];

  context.mocks.api(chatThreadsContract.list, ({ query, respond }) => {
    if (query.cursor === "next-page") {
      return respond(200, {
        pinned: [],
        threads: extraThreads,
        hasMore: false,
        nextCursor: null,
      });
    }
    return respond(200, {
      ...splitChatThreadListResponse(threads),
      hasMore: extraThreads.length > 0,
      nextCursor: extraThreads.length > 0 ? "next-page" : null,
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
    const thread = [...threads, ...extraThreads].find((candidate) => {
      return candidate.id === params.id;
    });
    return respond(200, {
      id: params.id,
      title: thread?.title ?? null,
      agentId: thread?.agent.id ?? AGENT_ID,
      activeRunIds: [],
      draftContent: null,
      draftAttachments: null,
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    });
  });
  context.mocks.api(chatThreadPinContract.pin, ({ params, respond }) => {
    threads = threads.map((thread) => {
      return thread.id === params.id
        ? { ...thread, pinnedAt: "2026-03-10T12:00:00Z" }
        : thread;
    });
    return respond(204);
  });
  context.mocks.api(chatThreadUnpinContract.unpin, ({ params, respond }) => {
    threads = threads.map((thread) => {
      return thread.id === params.id ? { ...thread, pinnedAt: null } : thread;
    });
    return respond(204);
  });
  context.mocks.api(
    chatThreadRenameContract.rename,
    ({ params, body, respond }) => {
      threads = threads.map((thread) => {
        return thread.id === params.id
          ? {
              ...thread,
              title: body.title,
              renamedAt: "2026-03-10T12:01:00Z",
            }
          : thread;
      });
      return respond(204);
    },
  );
  context.mocks.api(chatThreadByIdContract.delete, ({ params, respond }) => {
    threads = threads.filter((thread) => {
      return thread.id !== params.id;
    });
    return respond(204);
  });

  return { threads };
}

describe("zero sidebar", () => {
  it("keeps known threads visible while creating a new chat", async () => {
    prepareDefaultAgent();
    const createDeferred = context.mocks.deferred<void>();

    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(
        200,
        splitChatThreadListResponse([
          {
            id: EXISTING_THREAD_ID,
            title: "Existing conversation",
            agent: { id: AGENT_ID, avatarUrl: null },
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            running: false,
          },
        ]),
      );
    });
    context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
      await createDeferred.promise;
      return respond(201, {
        id: body.clientThreadId ?? "created-thread-id",
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
      });
    });
    context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        title:
          params.id === EXISTING_THREAD_ID ? "Existing conversation" : null,
        agentId: AGENT_ID,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const newChatButton = await waitFor(() => {
      expect(screen.getByText("Existing conversation")).toBeInTheDocument();
      return screen.getByLabelText("New chat with Zero");
    });

    click(newChatButton);

    await waitFor(() => {
      const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
      expect(
        within(sidebar).getByText("Existing conversation"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByText("New chat")).toBeInTheDocument();
      expect(
        sidebar.querySelectorAll('[data-testid="sidebar-skeleton"]'),
      ).toHaveLength(0);
    });

    createDeferred.resolve();
  });

  it("pins and unpins a chat thread from the sidebar menu", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
      createThread(AUTOMATION_THREAD_ID, "Running analysis", { running: true }),
      createThread(ARCHIVED_THREAD_ID, "Draft brief"),
    ]);
    context.mocks.api(chatThreadsContract.drafts, ({ respond }) => {
      return respond(200, { draftThreadIds: [ARCHIVED_THREAD_ID] });
    });
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      return respond(200, {
        unreads: [
          { threadId: INCIDENT_THREAD_ID, unreadAt: "2026-03-10T00:05:00Z" },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}?sidebar=detached-thread`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
      expect(
        within(threadRowByTitle("Release plan")).getByTestId(
          "chat-thread-list-pane-icon-main",
        ),
      ).toBeInTheDocument();
      expect(
        within(threadRowByTitle("Incident notes")).getByLabelText("Unread"),
      ).toBeInTheDocument();
      expect(
        within(threadRowByTitle("Running analysis")).getByLabelText("Running"),
      ).toBeInTheDocument();
      expect(
        within(threadRowByTitle("Draft brief")).getByLabelText("Draft"),
      ).toBeInTheDocument();
    });

    openThreadMenu("Release plan");
    click(menuItemByText("Pin chat"));

    await waitFor(() => {
      expect(
        within(threadRowByTitle("Release plan")).getByTestId(
          "chat-thread-pinned-indicator",
        ),
      ).toBeInTheDocument();
    });

    openThreadMenu("Release plan");
    click(menuItemByText("Unpin chat"));

    await waitFor(() => {
      expect(
        within(threadRowByTitle("Release plan")).queryByTestId(
          "chat-thread-pinned-indicator",
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("renames a chat thread from the sidebar menu", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
    ]);

    detachedSetupPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    });

    openThreadMenu("Release plan");
    click(menuItemByText("Rename chat"));

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    const titleInput = within(dialog).getByPlaceholderText("Chat title");
    expect(titleInput).toHaveValue("Release plan");

    await fill(titleInput, "Launch plan");
    click(buttonByText("Rename", dialog));

    await waitFor(() => {
      expect(within(sidebar()).getByText("Launch plan")).toBeInTheDocument();
      expect(
        within(sidebar()).queryByText("Release plan"),
      ).not.toBeInTheDocument();
    });
  });

  it("loads more sidebar chats and confirms deleting a chat with automations", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory(
      [
        createThread(EXISTING_THREAD_ID, "Release plan"),
        createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
      ],
      [createThread(ARCHIVED_THREAD_ID, "Archived context")],
    );
    context.mocks.data.automations([
      createMockAutomationView({
        id: "f0000001-0000-4000-a000-000000000401",
        name: "launch-cadence",
        chatThreadId: AUTOMATION_THREAD_ID,
        description: "Launch cadence",
        prompt: "Post the launch cadence",
      }),
      createMockAutomationView({
        id: "f0000001-0000-4000-a000-000000000402",
        name: "release-risk-review",
        chatThreadId: AUTOMATION_THREAD_ID,
        description: "Release risk review",
        prompt: "Review release risks",
      }),
    ]);

    detachedSetupPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(
        within(sidebar()).getByText("Scheduled launch"),
      ).toBeInTheDocument();
    });

    click(screen.getByTestId("sidebar-chat-threads-load-more"));

    await waitFor(() => {
      expect(
        within(sidebar()).getByText("Archived context"),
      ).toBeInTheDocument();
    });

    openThreadMenu("Scheduled launch");
    click(menuItemByText("Delete chat"));

    const dialog = await screen.findByRole("dialog", {
      name: "Delete chat and automations?",
    });
    expect(
      within(dialog).getByText(/2 linked automations/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Launch cadence")).toBeInTheDocument();
    expect(within(dialog).getByText("Release risk review")).toBeInTheDocument();

    click(buttonByText("Cancel", dialog));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", {
          name: "Delete chat and automations?",
        }),
      ).not.toBeInTheDocument();
      expect(
        within(sidebar()).getByText("Scheduled launch"),
      ).toBeInTheDocument();
    });

    openThreadMenu("Scheduled launch");
    click(menuItemByText("Delete chat"));

    const confirmDialog = await screen.findByRole("dialog", {
      name: "Delete chat and automations?",
    });
    click(buttonByText("Delete chat and automations", confirmDialog));

    await waitFor(() => {
      expect(
        within(sidebar()).queryByText("Scheduled launch"),
      ).not.toBeInTheDocument();
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });
  });

  it("cancels and confirms deleting a regular chat from the sidebar", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
    ]);

    detachedSetupPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    });

    openThreadMenu("Release plan");
    click(menuItemByText("Delete chat"));

    const dialog = await screen.findByRole("dialog", {
      name: "Delete chat?",
    });
    expect(
      within(dialog).getByText(
        "This will permanently delete this chat. Any task currently running in this chat will be stopped immediately. This action cannot be undone.",
      ),
    ).toBeInTheDocument();

    click(buttonByText("Cancel", dialog));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });

    openThreadMenu("Release plan");
    click(menuItemByText("Delete chat"));

    const confirmDialog = await screen.findByRole("dialog", {
      name: "Delete chat?",
    });
    click(buttonByText("Delete", confirmDialog));

    await waitFor(() => {
      expect(
        within(sidebar()).queryByText("Release plan"),
      ).not.toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    });
  });

  it("pins an agent from the conversation picker and starts that agent chat", async () => {
    prepareAgentTeam();
    const createDeferred = context.mocks.deferred<void>();

    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });
    context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
      await createDeferred.promise;
      return respond(201, {
        id: body.clientThreadId ?? "created-thread-id",
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
      });
    });
    context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        title: null,
        agentId: RESEARCH_AGENT_ID,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const sidebar = await waitFor(() => {
      return screen.getByRole("navigation", { name: "Sidebar" });
    });
    click(within(sidebar).getByLabelText("Open a conversation"));

    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();

    await fill(
      within(dialog).getByPlaceholderText("Search agents..."),
      "support",
    );

    await waitFor(() => {
      expect(
        within(dialog).queryByText("Research Agent"),
      ).not.toBeInTheDocument();
      expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
    });

    await fill(within(dialog).getByPlaceholderText("Search agents..."), "ops");

    await waitFor(() => {
      expect(within(dialog).getByText("No agents found")).toBeInTheDocument();
      expect(
        within(dialog).queryByText("Support Agent"),
      ).not.toBeInTheDocument();
    });

    click(within(dialog).getByLabelText("Clear search"));

    await waitFor(() => {
      expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    });

    click(within(dialog).getAllByLabelText("Pin to sidebar")[0]!);

    await waitFor(() => {
      expect(
        within(dialog).getByLabelText("Unpin Research Agent"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByText("Research Agent")).toBeInTheDocument();
    });

    click(within(dialog).getByLabelText("Unpin Research Agent"));

    await waitFor(() => {
      expect(
        within(dialog).queryByLabelText("Unpin Research Agent"),
      ).not.toBeInTheDocument();
      expect(
        within(sidebar).queryByText("Research Agent"),
      ).not.toBeInTheDocument();
    });

    click(within(dialog).getAllByLabelText("Pin to sidebar")[0]!);

    await waitFor(() => {
      expect(
        within(dialog).getByLabelText("Unpin Research Agent"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByText("Research Agent")).toBeInTheDocument();
    });

    const researchAgentButton = queryAllByRoleFast("button", dialog).find(
      (element) => {
        return element.textContent?.trim() === "Research Agent";
      },
    );
    if (!researchAgentButton) {
      throw new Error("Research Agent button not found");
    }
    click(researchAgentButton);

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Talk to" }),
      ).not.toBeInTheDocument();
      expect(
        within(sidebar).getByText("Chats with Research Agent"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByText("New chat")).toBeInTheDocument();
    });

    createDeferred.resolve();
  });

  it("collapses and reopens the sidebar", async () => {
    prepareDefaultAgent();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Collapse sidebar");
      }),
    );

    const expandButton = await screen.findByLabelText("Expand sidebar");
    click(expandButton);

    await waitFor(() => {
      expect(screen.queryByLabelText("Expand sidebar")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Collapse sidebar")).toBeInTheDocument();
    });
  });

  it("collapses and reopens the manage navigation section", async () => {
    prepareDefaultAgent();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const nav = await waitFor(() => {
      const current = sidebar();
      expect(within(current).getByText("Agents")).toBeInTheDocument();
      expect(within(current).getByText("Connectors")).toBeInTheDocument();
      return current;
    });

    const scrollArea = screen.getByTestId("sidebar-scroll-area");
    Object.defineProperty(scrollArea, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(scrollArea, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollArea, "scrollTop", {
      configurable: true,
      value: 120,
    });
    fireEvent.scroll(scrollArea);

    await waitFor(() => {
      expect(scrollArea.getAttribute("style")).toContain("box-shadow:");
    });

    const scrollWrapper = scrollArea.parentElement;
    if (!scrollWrapper) {
      throw new Error("Sidebar scroll wrapper not found");
    }
    fireEvent.mouseEnter(scrollWrapper);
    fireEvent.mouseLeave(scrollWrapper);

    Object.defineProperty(scrollArea, "scrollHeight", {
      configurable: true,
      value: 200,
    });
    fireEvent.scroll(scrollArea);

    click(within(nav).getByText("Manage"));

    await waitFor(() => {
      expect(within(nav).queryByText("Agents")).not.toBeInTheDocument();
      expect(within(nav).queryByText("Connectors")).not.toBeInTheDocument();
    });

    click(within(nav).getByText("Manage"));

    await waitFor(() => {
      expect(within(nav).getByText("Agents")).toBeInTheDocument();
      expect(within(nav).getByText("Connectors")).toBeInTheDocument();
    });
  });

  it("does not show skills in the sidebar manage navigation", async () => {
    prepareDefaultAgent();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.SkillsViewer]: true },
    });

    const nav = await waitFor(() => {
      return sidebar();
    });

    expect(within(nav).getByText("Agents")).toBeInTheDocument();
    expect(within(nav).queryByText("Skills")).not.toBeInTheDocument();
  });
});
