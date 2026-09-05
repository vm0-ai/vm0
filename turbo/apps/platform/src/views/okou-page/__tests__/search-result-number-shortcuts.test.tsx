import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatSearchContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import {
  artifactSummary,
  fileArtifactDetail,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListThread,
  fastButton,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();
const featureSwitches = {
  [FeatureSwitchKey.PinnedChatThreadSort]: true,
  [FeatureSwitchKey.SearchResultNumberShortcuts]: true,
} as const;
const SEARCH_LABEL = "Search chats, messages, workflows, and artifacts...";

async function openSearch(modifiers = { ctrlKey: true, metaKey: false }) {
  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    shiftKey: true,
    ...modifiers,
  });
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  return { dialog, search: within(dialog).getByPlaceholderText(SEARCH_LABEL) };
}

function numberedHints(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll("kbd")]
    .map((keycap) => {
      return keycap.textContent;
    })
    .filter((text): text is string => {
      return text !== null && /^[1-9]$/.test(text);
    });
}

function searchResultTitles(dialog: HTMLElement): string[] {
  return queryAllByRoleFast("option", dialog).map((option) => {
    return option.querySelector(".truncate")?.textContent ?? "";
  });
}

function installSearchResources() {
  const workflow: WorkflowSummary = {
    id: "f7000000-0000-4000-a000-000000000001",
    agentId: CHAT_LIST_AGENT_ID,
    agentName: "Support Agent",
    agentDisplayName: "Support Agent",
    name: "budget-review",
    displayName: "Budget review",
    description: null,
    visibility: "private",
    ownerUserId: "test-user",
    createdAt: "2026-08-01T01:00:00.000Z",
    canManage: true,
    canPublish: true,
    official: null,
  };
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    return respond(200, [workflow]);
  });
  context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
    return respond(200, {
      ...workflow,
      createdByUserId: workflow.ownerUserId,
      updatedByUserId: workflow.ownerUserId,
      updatedAt: workflow.createdAt,
      instruction: "Review the budget.",
      files: [],
      fileContents: [],
      automations: [],
    });
  });
  const artifact = artifactSummary(
    "f7000000-0000-4000-a000-000000000002",
    "file",
    "Budget report",
  );
  context.mocks.http.get(
    "https://cdn.vm7.io/search-shortcuts/budget.txt",
    () => {
      return new Response("Budget report contents", {
        headers: { "Content-Type": "text/plain" },
      });
    },
  );
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [artifact], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(
      200,
      fileArtifactDetail(artifact, {
        contentType: "text/plain",
        fileId: "f7000000-0000-4000-a000-000000000002",
        filename: "budget.txt",
        url: "https://cdn.vm7.io/search-shortcuts/budget.txt",
      }),
    );
  });
  return { workflow, artifact };
}

test.each([
  {
    platform: "Mac",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    modifiers: { metaKey: true, ctrlKey: false },
  },
  {
    platform: "Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    modifiers: { metaKey: false, ctrlKey: true },
  },
])(
  "Open the ninth current chat from search on $platform",
  async ({ userAgent, modifiers }) => {
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
      expect(sidebarThreadTitles()).toHaveLength(11);
    });
    const expectedTitles = sidebarThreadTitles();
    expect(expectedTitles.slice(0, 3)).toStrictEqual([
      "Chat 1",
      "Chat 2",
      "Chat 11",
    ]);
    click(fastButton("Hide chat list"));
    const { dialog, search } = await openSearch(modifiers);
    await waitFor(() => {
      expect(searchResultTitles(dialog)).toStrictEqual(expectedTitles);
      expect(numberedHints(dialog)).toStrictEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
      ]);
    });
    fireEvent.keyUp(search, { key: "Shift", ...modifiers, shiftKey: false });
    await waitFor(() => {
      expect(numberedHints(dialog)).toStrictEqual([]);
    });
    fireEvent.keyDown(search, { key: "Shift", ...modifiers, shiftKey: true });
    await waitFor(() => {
      expect(numberedHints(dialog)).toHaveLength(9);
    });
    fireEvent.keyDown(search, {
      key: "(",
      code: "Digit9",
      ...modifiers,
      shiftKey: true,
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(pathname()).toBe(`/chats/${threads[4]!.id}`);
    });
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  },
);

test("Empty search follows the current agent and unread filter", async () => {
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
    expect(sidebarThreadTitles()).toHaveLength(3);
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
    expect(sidebarThreadTitles()).toStrictEqual([
      "Unread pin",
      "Unread regular chat",
    ]);
  });
  const { dialog, search } = await openSearch();
  await fill(search, "   ");
  await waitFor(() => {
    expect(searchResultTitles(dialog)).toStrictEqual([
      "Unread pin",
      "Unread regular chat",
    ]);
  });
  fireEvent.keyDown(search, {
    key: "!",
    code: "Digit1",
    ctrlKey: true,
    shiftKey: true,
  });
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${second.id}`);
  });
});

test("Search numbers follow fresh matches and restart after filtering", async () => {
  const titleMatch = chatListThread(1, "Budget planning");
  const messageMatch = chatListThread(2, "Project notes");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 26,
    threads: [titleMatch, messageMatch],
  });
  context.mocks.api(chatSearchContract.search, ({ query, respond }) => {
    return respond(200, {
      results:
        query.keyword === "budget"
          ? [
              {
                chatThreadId: messageMatch.id,
                agentName: "Support Agent",
                matchedMessage: {
                  chatThreadId: messageMatch.id,
                  role: "user",
                  content: "Review the budget",
                  createdAt: "2026-08-01T01:00:00.000Z",
                  seqId: 1,
                  runId: null,
                },
                matchedRanges: [{ start: 11, end: 17 }],
              },
            ]
          : [],
      hasMore: false,
    });
  });
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth: workspace.auth,
    featureSwitches,
  });
  const { dialog, search } = await openSearch();
  await fill(search, "budget");
  fireEvent.keyDown(search, { key: "Shift", ctrlKey: true, shiftKey: true });
  await waitFor(() => {
    expect(searchResultTitles(dialog)).toStrictEqual([
      "Budget planning",
      "Project notes",
    ]);
    expect(numberedHints(dialog)).toStrictEqual(["1", "2"]);
  });
  const messagesTab = queryAllByRoleFast("tab", dialog).find((tab) => {
    return tab.textContent === "Messages";
  });
  if (!messagesTab) {
    throw new Error("Expected Messages filter");
  }
  click(messagesTab);
  await waitFor(() => {
    expect(searchResultTitles(dialog)).toStrictEqual(["Project notes"]);
    expect(numberedHints(dialog)).toStrictEqual(["1"]);
  });
  fireEvent.keyDown(search, {
    key: "!",
    code: "Digit1",
    ctrlKey: true,
    shiftKey: true,
  });
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${messageMatch.id}`);
  });
});

test("Search shortcuts preserve typing and reset hints when focus is lost or the dialog closes", async () => {
  const first = chatListThread(1, "First chat");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 27,
    threads: [first],
  });
  await setupPage({
    context,
    path: `/chats/${first.id}`,
    auth: workspace.auth,
    featureSwitches,
  });
  const { dialog, search } = await openSearch();
  await waitFor(() => {
    expect(numberedHints(dialog)).toStrictEqual(["1"]);
  });
  for (const ignored of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { altKey: true },
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
    search.dispatchEvent(event);
    expect(event.defaultPrevented).toBeFalsy();
    expect(dialog).toBeInTheDocument();
  }
  fireEvent.keyDown(search, {
    key: "(",
    code: "Digit9",
    ctrlKey: true,
    shiftKey: true,
  });
  expect(dialog).toBeInTheDocument();
  expect(search).toHaveValue("");
  fireEvent.blur(window);
  await waitFor(() => {
    expect(numberedHints(dialog)).toStrictEqual([]);
  });
  search.focus();
  await userEvent.keyboard("19");
  expect(search).toHaveValue("19");
  await fill(search, "");
  fireEvent.keyDown(search, { key: "Shift", ctrlKey: true, shiftKey: true });
  await waitFor(() => {
    expect(numberedHints(dialog)).toStrictEqual(["1"]);
  });
  fireEvent.keyDown(search, { key: "Escape", code: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(fastButton("Search workspace"));
  const reopened = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  await waitFor(() => {
    expect(searchResultTitles(reopened)).toStrictEqual(["First chat"]);
  });
  expect(numberedHints(reopened)).toStrictEqual([]);
});

test.each([
  {
    filter: "All",
    titles: ["Budget planning", "Budget review", "Budget report"],
    hints: ["1", "2", "3"],
    digit: "3",
  },
  { filter: "Workflows", titles: ["Budget review"], hints: ["1"], digit: "1" },
])(
  "Open a resource from numbered search results in $filter",
  async ({ filter, titles, hints, digit }) => {
    const titleMatch = chatListThread(1, "Budget planning");
    const workspace = await installContinuityWorkspace(context, {
      caseId: 29,
      threads: [titleMatch],
    });
    const { workflow, artifact } = installSearchResources();
    await setupPage({
      context,
      path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
      auth: workspace.auth,
      featureSwitches,
    });
    const { dialog, search } = await openSearch();
    await fill(search, "budget");
    fireEvent.keyDown(search, { key: "Shift", ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(searchResultTitles(dialog)).toStrictEqual([
        "Budget planning",
        "Budget review",
        "Budget report",
      ]);
      expect(numberedHints(dialog)).toStrictEqual(["1", "2", "3"]);
    });
    const tab = queryAllByRoleFast("tab", dialog).find((item) => {
      return item.textContent === filter;
    });
    if (!tab) {
      throw new Error(`Expected ${filter} filter`);
    }
    click(tab);
    await waitFor(() => {
      expect(searchResultTitles(dialog)).toStrictEqual(titles);
      expect(numberedHints(dialog)).toStrictEqual(hints);
    });
    fireEvent.keyDown(search, {
      key: digit,
      code: `Digit${digit}`,
      ctrlKey: true,
      shiftKey: true,
    });
    const expectedPath =
      filter === "Workflows" ? `/workflows/${workflow.id}` : "/artifacts";
    const expectedArtifact = filter === "Workflows" ? null : artifact.id;
    const expectedTab = filter === "Workflows" ? null : "file";
    await waitFor(() => {
      expect(pathname()).toBe(expectedPath);
      const searchParams = new URL(window.location.href).searchParams;
      expect(searchParams.get("artifact")).toBe(expectedArtifact);
      expect(searchParams.get("tab")).toBe(expectedTab);
    });
  },
);

test("Disabling search shortcuts preserves the original workspace-wide empty search", async () => {
  const current = chatListThread(1, "Current chat");
  const foreign = chatListThread(2, "Another agent's chat", {
    agentId: "c7000000-0000-4000-a000-000000000002",
  });
  const workspace = await installContinuityWorkspace(context, {
    caseId: 28,
    threads: [current, foreign],
  });
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth: workspace.auth,
    featureSwitches: {
      ...featureSwitches,
      [FeatureSwitchKey.SearchResultNumberShortcuts]: false,
    },
  });
  const { dialog, search } = await openSearch();
  await waitFor(() => {
    expect(searchResultTitles(dialog)).toStrictEqual([
      "Another agent's chat",
      "Current chat",
    ]);
  });
  expect(numberedHints(dialog)).toStrictEqual([]);
  const event = new KeyboardEvent("keydown", {
    key: "!",
    code: "Digit1",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  search.dispatchEvent(event);
  expect(event.defaultPrevented).toBeFalsy();
  expect(dialog).toBeInTheDocument();
});
