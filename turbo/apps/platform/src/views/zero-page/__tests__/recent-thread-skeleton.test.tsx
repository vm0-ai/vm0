import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
} from "@vm0/core/contracts/chat-threads";

const context = testContext();
const mockApi = createMockApi(context);

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "t0000000-0000-4000-a000-000000000001";

function mockAgentsWithThreads() {
  setMockTeam([
    {
      id: DEFAULT_AGENT_ID,
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "agent-alpha",
      displayName: "Alpha Bot",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_2",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, {
        threads: [
          {
            id: THREAD_ID,
            title: "My test conversation",
            agent: { id: "agent-alpha", avatarUrl: null },
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            isRead: false,
            isArchived: false,
            running: false,
          },
        ],
      });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: THREAD_ID,
        title: "My test conversation",
        agentId: "agent-alpha",
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
  setMockUserPreferences({ pinnedAgentIds: ["agent-alpha"] });
}

describe("recent thread skeleton (#7546)", () => {
  it("should retain recent threads without skeleton when navigating to a chat session", async () => {
    mockAgentsWithThreads();

    detachedSetupPage({ context, path: "/agents/agent-alpha/chat" });

    // Wait for the recent thread to appear in the sidebar
    await waitFor(() => {
      expect(
        within(screen.getByRole("navigation", { name: "Sidebar" })).getByText(
          "My test conversation",
        ),
      ).toBeInTheDocument();
    });
    const sidebar = screen.getByRole("navigation", { name: "Sidebar" });

    // Make chat-threads API hang so the only way the sidebar can show
    // threads is by retaining the previous useLastLoadable data.
    // The deferred is resolved explicitly after assertions to allow clean
    // clearAllDetached() completion in afterEach.
    const hangDeferred = createDeferredPromise<void>(context.signal);
    server.use(
      mockApi(chatThreadsContract.list, async ({ respond }) => {
        await hangDeferred.promise;
        return respond(200, { threads: [] });
      }),
    );

    // Click the recent thread to navigate to /chats/:id
    click(within(sidebar).getByText("My test conversation"));

    // After navigation, the sidebar should still show the thread text
    // (retained by useLastLoadable) instead of skeleton placeholders.
    await waitFor(() => {
      const nav = screen.getByRole("navigation", { name: "Sidebar" });
      expect(nav.querySelectorAll(".animate-pulse")).toHaveLength(0);
      expect(within(nav).getByText("My test conversation")).toBeInTheDocument();
    });

    // Resolve the deferred so the hanging handler completes cleanly,
    // allowing clearAllDetached() in afterEach to finish without timeout.
    hangDeferred.resolve();
  });
});
