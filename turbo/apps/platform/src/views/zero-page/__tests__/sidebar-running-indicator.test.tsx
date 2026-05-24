/**
 * Sidebar running indicator tests.
 *
 * Covers the truth table for thread-row indicators:
 *  - running               → sky-600 pulsing dot (Running), shown even when selected
 *  - unread && !running    → primary (orange) dot (Unread), hidden when selected
 *  - running wins over unread
 *  - running row is not bold (font-medium stays bound to unread only,
 *    to avoid a weight flicker when the run finishes)
 *
 * Also covers the `threadListChanged` Ably signal: when fired, the sidebar
 * reloads the list and reflects the latest running state.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { threadListChanged } from "../../../mocks/mock-helpers.ts";

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
      return respond(200, { threads: threadsRef.current });
    }),
    mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        title: null,
        agentId: DEFAULT_AGENT_ID,
        chatMessages: [],
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

beforeEach(() => {
  setMockUserPreferences({ pinnedAgentIds: [] });
});

describe("sidebar running indicator", () => {
  it("renders a Running dot on a running, unselected thread", async () => {
    mockAPIs({
      current: [
        {
          id: "thread-1",
          title: "Active work",
          agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: true,
          running: true,
        },
      ],
    });
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(within(getSidebar()).getByText("Active work")).toBeInTheDocument();
      expect(
        within(getSidebar()).getByLabelText("Running"),
      ).toBeInTheDocument();
      expect(
        within(getSidebar()).queryByLabelText("Unread"),
      ).not.toBeInTheDocument();
    });
  });

  it("renders Running indicator on the selected thread when running", async () => {
    mockAPIs({
      current: [
        {
          id: "thread-selected",
          title: "Selected running",
          agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: false,
          running: true,
        },
      ],
    });
    detachedSetupPage({ context, path: "/chats/thread-selected" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Selected running"),
      ).toBeInTheDocument();
      expect(
        within(getSidebar()).getByLabelText("Running"),
      ).toBeInTheDocument();
      expect(
        within(getSidebar()).queryByLabelText("Unread"),
      ).not.toBeInTheDocument();
    });
  });

  it("does not render Unread indicator on the selected thread", async () => {
    mockAPIs({
      current: [
        {
          id: "thread-selected-unread",
          title: "Selected unread",
          agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: false,
          running: false,
        },
      ],
    });
    detachedSetupPage({ context, path: "/chats/thread-selected-unread" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Selected unread"),
      ).toBeInTheDocument();
      expect(
        within(getSidebar()).queryByLabelText("Running"),
      ).not.toBeInTheDocument();
      expect(
        within(getSidebar()).queryByLabelText("Unread"),
      ).not.toBeInTheDocument();
    });
  });

  it("prefers Running over Unread when both conditions hold", async () => {
    mockAPIs({
      current: [
        {
          id: "thread-both",
          title: "Running and unread",
          agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: false,
          running: true,
        },
      ],
    });
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Running and unread"),
      ).toBeInTheDocument();
      expect(
        within(getSidebar()).getByLabelText("Running"),
      ).toBeInTheDocument();
      expect(
        within(getSidebar()).queryByLabelText("Unread"),
      ).not.toBeInTheDocument();
    });
  });

  it("reloads the list and shows the running dot when threadListChanged fires", async () => {
    const threadsRef: { current: ThreadFixture[] } = {
      current: [
        {
          id: "thread-flips",
          title: "Will flip to running",
          agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: true,
          running: false,
        },
      ],
    };
    mockAPIs(threadsRef);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Will flip to running"),
      ).toBeInTheDocument();
    });
    expect(
      within(getSidebar()).queryByLabelText("Running"),
    ).not.toBeInTheDocument();

    threadsRef.current = [{ ...threadsRef.current[0]!, running: true }];
    threadListChanged();

    await waitFor(() => {
      expect(
        within(getSidebar()).getByLabelText("Running"),
      ).toBeInTheDocument();
    });
  });
});
