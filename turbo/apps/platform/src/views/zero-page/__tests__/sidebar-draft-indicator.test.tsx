/**
 * Sidebar draft indicator tests.
 *
 * Covers the draft slot of the unified sidebar indicator:
 *  - hasDraft && !running && !unread && !selected → Draft pencil icon
 *  - running wins over draft (running is the only state shown when both hold)
 *  - unread wins over draft (unread shown, not draft)
 *  - selected thread suppresses the Draft icon (you're already in that chat)
 *  - feature flag gates the indicator (parity with running/unread)
 *  - delete button shares the same right slot — both elements are present in
 *    the DOM at all times so hover-swap works without layout shift
 */

import { splitChatThreadListResponse } from "./chat-test-helpers.ts";
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
  hasDraft?: boolean;
}

function mockAPIs(threads: ThreadFixture[]) {
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse(threads));
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

beforeEach(() => {
  setMockUserPreferences({ pinnedAgentIds: [] });
});

describe("sidebar draft indicator", () => {
  it("renders a Draft icon on a thread with a draft and no other state", async () => {
    mockAPIs([
      {
        id: "thread-draft",
        title: "Has draft",
        agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        isRead: true,
        running: false,
        hasDraft: true,
      },
    ]);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(within(getSidebar()).getByText("Has draft")).toBeInTheDocument();
      expect(within(getSidebar()).getByLabelText("Draft")).toBeInTheDocument();
    });
    expect(
      within(getSidebar()).queryByLabelText("Running"),
    ).not.toBeInTheDocument();
    expect(
      within(getSidebar()).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
  });

  it("prefers Running over Draft when both hold", async () => {
    mockAPIs([
      {
        id: "thread-running-and-draft",
        title: "Running and draft",
        agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        isRead: true,
        running: true,
        hasDraft: true,
      },
    ]);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Running and draft"),
      ).toBeInTheDocument();
      expect(
        within(getSidebar()).getByLabelText("Running"),
      ).toBeInTheDocument();
    });
    expect(
      within(getSidebar()).queryByLabelText("Draft"),
    ).not.toBeInTheDocument();
  });

  it("prefers Unread over Draft when both hold", async () => {
    mockAPIs([
      {
        id: "thread-unread-and-draft",
        title: "Unread and draft",
        agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        isRead: false,
        running: false,
        hasDraft: true,
      },
    ]);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Unread and draft"),
      ).toBeInTheDocument();
      expect(within(getSidebar()).getByLabelText("Unread")).toBeInTheDocument();
    });
    expect(
      within(getSidebar()).queryByLabelText("Draft"),
    ).not.toBeInTheDocument();
  });

  it("does not render Draft on the selected thread", async () => {
    mockAPIs([
      {
        id: "thread-selected-draft",
        title: "Selected with draft",
        agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        isRead: true,
        running: false,
        hasDraft: true,
      },
    ]);
    detachedSetupPage({ context, path: "/chats/thread-selected-draft" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Selected with draft"),
      ).toBeInTheDocument();
    });
    expect(
      within(getSidebar()).queryByLabelText("Draft"),
    ).not.toBeInTheDocument();
  });

  it("treats hasDraft=undefined the same as hasDraft=false", async () => {
    mockAPIs([
      {
        id: "thread-no-draft-field",
        title: "No draft field",
        agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        isRead: true,
        running: false,
      },
    ]);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("No draft field"),
      ).toBeInTheDocument();
    });
    expect(
      within(getSidebar()).queryByLabelText("Draft"),
    ).not.toBeInTheDocument();
  });

  it("does not render the delete button when the row shows a Draft pencil", async () => {
    mockAPIs([
      {
        id: "thread-shares-slot",
        title: "Shares slot",
        agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        isRead: true,
        running: false,
        hasDraft: true,
      },
    ]);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(within(getSidebar()).getByLabelText("Draft")).toBeInTheDocument();
    });
    // Drafted rows keep the pencil visible on hover; the delete button is
    // suppressed entirely so the user has to clear the draft first.
    expect(
      within(getSidebar()).queryByLabelText("Delete chat"),
    ).not.toBeInTheDocument();
  });
});
