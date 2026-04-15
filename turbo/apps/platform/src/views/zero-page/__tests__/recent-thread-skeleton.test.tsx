import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "t0000000-0000-4000-a000-000000000001";

function mockAgentsWithThreads() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
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
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({
        threads: [
          {
            id: THREAD_ID,
            title: "My test conversation",
            agentId: "agent-alpha",
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          },
        ],
      });
    }),
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: THREAD_ID,
        title: "My test conversation",
        agentId: "agent-alpha",
        chatMessages: [],
        latestSessionId: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
  );
  setMockUserPreferences({ pinnedAgentIds: ["agent-alpha"] });
}

describe("recent thread skeleton (#7546)", () => {
  it("should retain recent threads without skeleton when navigating to a chat session", async () => {
    const user = userEvent.setup();
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
      http.get("*/api/zero/chat-threads", async () => {
        await hangDeferred.promise;
        return HttpResponse.json({ threads: [] });
      }),
    );

    // Click the recent thread to navigate to /chats/:id
    await user.click(within(sidebar).getByText("My test conversation"));

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
