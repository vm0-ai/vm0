/**
 * Display and interaction tests for ZeroChatListPage (/chats).
 *
 * Covers the "Load all" button that appears when the server returns
 * hasMore=true, and verifies it disappears after loading all threads.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { chatThreadsContract } from "@vm0/core/contracts/chat-threads";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

beforeEach(() => {
  setMockUserPreferences({ pinnedAgentIds: [] });
});

describe("zero chat list page - load all button (CHAT-LIST-001)", () => {
  it("shows Load all when server returns hasMore=true and hides it after clicking", async () => {
    const user = userEvent.setup();

    const recentThread = {
      id: "thread-recent",
      title: "Recent chat",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
      isRead: false,
      isArchived: false,
      running: false,
    };
    const olderThread = {
      id: "thread-older",
      title: "Older chat",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-03-09T00:00:00Z",
      updatedAt: "2026-03-09T00:00:00Z",
      isRead: false,
      isArchived: false,
      running: false,
    };

    server.use(
      mockApi(chatThreadsContract.list, ({ query, respond }) => {
        return respond(200, {
          threads:
            query.all === "true" ? [recentThread, olderThread] : [recentThread],
          hasMore: query.all !== "true",
        });
      }),
    );

    detachedSetupPage({ context, path: "/chats" });

    await waitFor(() => {
      expect(screen.getAllByText("Recent chat").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Load all").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("Older chat")).not.toBeInTheDocument();

    await user.click(screen.getAllByText("Load all")[0]);

    await waitFor(() => {
      expect(screen.getAllByText("Older chat").length).toBeGreaterThan(0);
      expect(screen.queryByText("Load all")).not.toBeInTheDocument();
    });
  });
});
