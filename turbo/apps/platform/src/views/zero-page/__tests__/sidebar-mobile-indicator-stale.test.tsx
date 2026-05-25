/**
 * Reproduction for: mobile sidebar shows "Unread" instead of "Running"
 * on first-open when the user is already inside a working chat thread.
 *
 * Scenario described by the user:
 *  1. User opens a chat thread that has at least one non-terminal run
 *     (i.e. should display the Running indicator in the sidebar).
 *  2. User taps the menu button on the mobile top bar to open the sidebar.
 *  3. Bug: other running threads in the sidebar render with the Unread dot,
 *     not the Running dot.
 *  4. Close + reopen the sidebar — indicators now render correctly.
 *
 * These tests pin the truth table for the moment the mobile sidebar first
 * becomes visible from inside a chat-thread route. They are siblings to
 * sidebar-running-indicator.test.tsx, which covers the indicator logic in
 * isolation; here we exercise the mobile-open transition specifically.
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  setSidebarExpanded$,
  sidebarExpanded$,
} from "../../../signals/zero-page/zero-nav.ts";
import { threadListChanged } from "../../../mocks/mock-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { splitChatThreadListResponse } from "./chat-test-helpers.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

interface ThreadFixture {
  id: string;
  title: string;
  agent: { id: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  running: boolean;
}

function mockAPIs(threadsRef: { current: ThreadFixture[] }) {
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse(threadsRef.current));
    }),
    mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        title: null,
        agentId: DEFAULT_AGENT_ID,
        latestSessionId: null,
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    mockApi(chatThreadMessagesContract.list, ({ respond }) => {
      return respond(200, { messages: [] });
    }),
  );
}

function getSidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Sidebar" });
}

const ACTIVE_THREAD_ID = "thread-active-running";
const OTHER_RUNNING_THREAD_ID = "thread-other-running";
const OTHER_UNREAD_THREAD_ID = "thread-other-unread";

function fixtures(): ThreadFixture[] {
  return [
    {
      id: ACTIVE_THREAD_ID,
      title: "Active running",
      agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:02Z",
      isRead: false,
      running: true,
    },
    {
      id: OTHER_RUNNING_THREAD_ID,
      title: "Other running",
      agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:01Z",
      isRead: false,
      running: true,
    },
    {
      id: OTHER_UNREAD_THREAD_ID,
      title: "Other unread",
      agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
      isRead: false,
      running: false,
    },
  ];
}

function rowFor(threadId: string): HTMLElement {
  const link = document.querySelector(`a[data-chat-thread-id="${threadId}"]`);
  if (!(link instanceof HTMLElement)) {
    throw new Error(`thread row not rendered: ${threadId}`);
  }
  const row = link.parentElement;
  if (!(row instanceof HTMLElement)) {
    throw new Error(`thread row has no parent: ${threadId}`);
  }
  return row;
}

describe("mobile sidebar: first-open indicator state", () => {
  it("renders Running on a non-selected running thread when the sidebar is first opened from inside a working chat", async () => {
    mockAPIs({ current: fixtures() });

    detachedSetupPage({
      context,
      path: `/chats/${ACTIVE_THREAD_ID}`,
    });

    // Wait until the sidebar has loaded the thread list.
    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Other running"),
      ).toBeInTheDocument();
    });

    // Simulate the user tapping the mobile menu button to expand the sidebar
    // for the first time after entering the working chat.
    const menuButton = screen.getByLabelText("Open menu");
    click(menuButton);

    // The other running thread must render the Running indicator, not Unread.
    await waitFor(() => {
      const row = rowFor(OTHER_RUNNING_THREAD_ID);
      expect(within(row).getByLabelText("Running")).toBeInTheDocument();
      expect(within(row).queryByLabelText("Unread")).not.toBeInTheDocument();
    });

    // And a separately-unread, non-running thread must still render Unread.
    const unreadRow = rowFor(OTHER_UNREAD_THREAD_ID);
    expect(within(unreadRow).getByLabelText("Unread")).toBeInTheDocument();
    expect(
      within(unreadRow).queryByLabelText("Running"),
    ).not.toBeInTheDocument();
  });

  it("keeps the Running indicator on a non-selected running thread across a close+reopen of the mobile sidebar", async () => {
    mockAPIs({ current: fixtures() });

    detachedSetupPage({
      context,
      path: `/chats/${ACTIVE_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Other running"),
      ).toBeInTheDocument();
    });

    // Open → expect Running on the other thread.
    context.store.set(setSidebarExpanded$, true);
    await waitFor(() => {
      const row = rowFor(OTHER_RUNNING_THREAD_ID);
      expect(within(row).getByLabelText("Running")).toBeInTheDocument();
    });

    // Close.
    context.store.set(setSidebarExpanded$, false);

    // Reopen → indicator must still be Running, not flip to Unread.
    context.store.set(setSidebarExpanded$, true);
    await waitFor(() => {
      const row = rowFor(OTHER_RUNNING_THREAD_ID);
      expect(within(row).getByLabelText("Running")).toBeInTheDocument();
      expect(within(row).queryByLabelText("Unread")).not.toBeInTheDocument();
    });
  });

  /**
   * Models the timing the user described:
   *   1. The thread list was last fetched while the other thread had no
   *      active run yet → API returned running:false, isRead:false → Unread.
   *   2. The user enters /chats/ACTIVE — the other thread's run kicks off
   *      server-side, but no Ably refresh has arrived yet on the client.
   *   3. The user opens the mobile sidebar before the refresh arrives →
   *      observes the stale Unread dot.
   *   4. threadListChanged arrives → list refetches with running:true.
   *   5. The user closes and reopens the sidebar → now sees Running.
   *
   * The test pins both phases so that if a future change makes the sidebar
   * suppress the Ably-driven refresh while collapsed (or, conversely, if it
   * starts force-refreshing on every open), the regression shows up here.
   */
  it("updates a stale Unread indicator to Running once threadListChanged fires while the sidebar is open", async () => {
    const threadsRef = { current: fixtures() };
    // Other-running thread initially looks like an unread, non-running row.
    threadsRef.current = threadsRef.current.map((t) => {
      if (t.id === OTHER_RUNNING_THREAD_ID) {
        return { ...t, running: false };
      }
      return t;
    });
    mockAPIs(threadsRef);

    detachedSetupPage({
      context,
      path: `/chats/${ACTIVE_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Other running"),
      ).toBeInTheDocument();
    });

    context.store.set(setSidebarExpanded$, true);

    // Stale state: Unread, not Running.
    await waitFor(() => {
      const row = rowFor(OTHER_RUNNING_THREAD_ID);
      expect(within(row).getByLabelText("Unread")).toBeInTheDocument();
      expect(within(row).queryByLabelText("Running")).not.toBeInTheDocument();
    });

    // Server pushes the run-started event → list refetch → running:true.
    threadsRef.current = threadsRef.current.map((t) => {
      if (t.id === OTHER_RUNNING_THREAD_ID) {
        return { ...t, running: true };
      }
      return t;
    });
    threadListChanged();

    // The sidebar must reflect the new state without requiring a manual
    // close+reopen by the user.
    await waitFor(() => {
      const row = rowFor(OTHER_RUNNING_THREAD_ID);
      expect(within(row).getByLabelText("Running")).toBeInTheDocument();
      expect(within(row).queryByLabelText("Unread")).not.toBeInTheDocument();
    });
  });
});

/**
 * Refined repro: user clarified the trigger is "right after a chat thread
 * switch just completed, the first sidebar open shows an Unread indicator".
 *
 * Test flow mirrors what the user actually does on mobile:
 *   1. Start on the agent landing page (no thread selected) with one
 *      running, unread thread X in the list.
 *   2. Open the mobile sidebar → click X to switch into it.
 *      Per the existing close-on-select behaviour, the sidebar collapses
 *      and the URL becomes /chats/X.
 *   3. Reopen the sidebar.
 *   4. X is now the selected/highlighted row. The truth table says:
 *        - running:true  → Running indicator must render even when selected.
 *        - unread + selected → Unread indicator must be SUPPRESSED.
 *      So X must show Running and not Unread on this first reopen.
 */
describe("mobile sidebar: indicator after navigating into a chat", () => {
  const RUNNING_TARGET_ID = "thread-running-target";

  function navigationFixtures(): ThreadFixture[] {
    return [
      {
        id: RUNNING_TARGET_ID,
        title: "Target running",
        agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:01Z",
        isRead: false,
        running: true,
      },
    ];
  }

  function mockTeam() {
    setMockTeam([
      {
        id: DEFAULT_AGENT_ID,
        displayName: "Zero",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
  }

  it("shows Running (not Unread) on the just-switched-to running thread when the sidebar is reopened", async () => {
    mockTeam();
    mockAPIs({ current: navigationFixtures() });

    detachedSetupPage({
      context,
      path: `/agents/${DEFAULT_AGENT_ID}/chat`,
    });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Target running"),
      ).toBeInTheDocument();
    });

    // Open sidebar and click the running thread to switch into it.
    context.store.set(setSidebarExpanded$, true);
    await waitFor(() => {
      expect(screen.getByLabelText("Sidebar overlay")).toBeInTheDocument();
    });
    const anchor = within(getSidebar())
      .getByText("Target running")
      .closest("a");
    if (!anchor) {
      throw new Error("Target running anchor missing");
    }
    click(anchor);

    // Navigation lands at the running thread and the sidebar auto-collapses.
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${RUNNING_TARGET_ID}`);
      expect(context.store.get(sidebarExpanded$)).toBeFalsy();
    });

    // User reopens the sidebar for the first time after the switch.
    context.store.set(setSidebarExpanded$, true);
    await waitFor(() => {
      expect(screen.getByLabelText("Sidebar overlay")).toBeInTheDocument();
    });

    // The just-switched-to row must keep its Running indicator and must
    // NOT flip to (or surface) an Unread indicator.
    const row = rowFor(RUNNING_TARGET_ID);
    expect(within(row).getByLabelText("Running")).toBeInTheDocument();
    expect(within(row).queryByLabelText("Unread")).not.toBeInTheDocument();
  });

  it("does not surface an Unread indicator on the selected thread when it is unread but not running", async () => {
    mockTeam();
    const unreadOnly: ThreadFixture[] = [
      {
        id: RUNNING_TARGET_ID,
        title: "Target unread",
        agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:01Z",
        isRead: false,
        running: false,
      },
    ];
    mockAPIs({ current: unreadOnly });

    detachedSetupPage({
      context,
      path: `/agents/${DEFAULT_AGENT_ID}/chat`,
    });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Target unread"),
      ).toBeInTheDocument();
    });

    context.store.set(setSidebarExpanded$, true);
    await waitFor(() => {
      expect(screen.getByLabelText("Sidebar overlay")).toBeInTheDocument();
    });
    const anchor = within(getSidebar()).getByText("Target unread").closest("a");
    if (!anchor) {
      throw new Error("Target unread anchor missing");
    }
    click(anchor);

    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${RUNNING_TARGET_ID}`);
      expect(context.store.get(sidebarExpanded$)).toBeFalsy();
    });

    context.store.set(setSidebarExpanded$, true);
    await waitFor(() => {
      expect(screen.getByLabelText("Sidebar overlay")).toBeInTheDocument();
    });

    // First-reopen check: the row is selected. Selected + unread MUST suppress
    // the Unread dot. If it appears here, this is the reproduction.
    const row = rowFor(RUNNING_TARGET_ID);
    expect(within(row).queryByLabelText("Unread")).not.toBeInTheDocument();
  });
});
