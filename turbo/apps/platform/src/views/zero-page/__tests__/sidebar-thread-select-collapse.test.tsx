import { splitChatThreadListResponse } from "./chat-test-helpers.ts";
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import {
  setSidebarExpanded$,
  sidebarExpanded$,
} from "../../../signals/zero-page/zero-nav.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
} from "@vm0/api-contracts/contracts/chat-threads";

const context = testContext();
const mockApi = createMockApi(context);

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function mockAPIs() {
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
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(
        200,
        splitChatThreadListResponse([
          {
            id: "thread-history-1",
            title: "History thread",
            agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            isRead: true,
            running: false,
          },
        ]),
      );
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: "thread-history-1",
        title: "History thread",
        agentId: DEFAULT_AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
  );
}

describe("sidebar collapses when selecting a history thread from /agents/:agentId/chat", () => {
  it("collapses the mobile sidebar after navigating to the selected thread", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: `/agents/${DEFAULT_AGENT_ID}/chat`,
    });

    // Wait for sidebar thread list to render
    await waitFor(() => {
      expect(screen.getByText("History thread")).toBeInTheDocument();
    });

    // Simulate the user opening the sidebar on mobile
    context.store.set(setSidebarExpanded$, true);
    await waitFor(() => {
      expect(screen.getByLabelText("Sidebar overlay")).toBeInTheDocument();
    });
    expect(context.store.get(sidebarExpanded$)).toBeTruthy();

    // Click the history thread row in the sidebar
    const anchor = screen.getByText("History thread").closest("a");
    expect(anchor).not.toBeNull();
    click(anchor!);

    // Navigation should kick in
    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-history-1");
    });

    // And the sidebar should auto-collapse on mobile
    await waitFor(() => {
      expect(context.store.get(sidebarExpanded$)).toBeFalsy();
    });
  });
});
