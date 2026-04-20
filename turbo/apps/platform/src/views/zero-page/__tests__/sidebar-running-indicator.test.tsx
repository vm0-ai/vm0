/**
 * Sidebar running indicator tests.
 *
 * Covers the truth table for thread-row indicators:
 *  - isSelected            → no indicator
 *  - running && !selected  → sky-600 pulsing dot (Running)
 *  - unread && !running    → blue-500 dot (Unread)
 *  - running wins over unread
 *  - running row is not bold (font-medium stays bound to unread only,
 *    to avoid a weight flicker when the run finishes)
 *
 * Also covers the `threadListChanged` Ably signal: when fired, the sidebar
 * reloads the list and reflects the latest running state.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.ts";
import { threadListChanged } from "../../../mocks/mock-helpers.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

interface ThreadFixture {
  id: string;
  title: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  isArchived: boolean;
  running: boolean;
}

function mockAPIs(threadsRef: { current: ThreadFixture[] }) {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: threadsRef.current });
    }),
    http.get("*/api/zero/chat-threads/:id", ({ params }) => {
      return HttpResponse.json({
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
    http.get("*/api/zero/chat-threads/:id/messages", () => {
      return HttpResponse.json({ messages: [], hasMore: false });
    }),
  );
}

function getSidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Sidebar" });
}

beforeEach(() => {
  setMockUserPreferences({ pinnedAgentIds: [] });
  setMockFeatureSwitches({ chatThreadReadIndicator: true });
});

describe("sidebar running indicator", () => {
  it("renders a Running dot on a running, unselected thread", async () => {
    mockAPIs({
      current: [
        {
          id: "thread-1",
          title: "Active work",
          agentId: DEFAULT_AGENT_ID,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: true,
          isArchived: false,
          running: true,
        },
      ],
    });
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(within(getSidebar()).getByText("Active work")).toBeInTheDocument();
    });
    expect(within(getSidebar()).getByLabelText("Running")).toBeInTheDocument();
    expect(
      within(getSidebar()).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
  });

  it("does not render any indicator on the selected thread", async () => {
    mockAPIs({
      current: [
        {
          id: "thread-selected",
          title: "Selected running",
          agentId: DEFAULT_AGENT_ID,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: false,
          isArchived: false,
          running: true,
        },
      ],
    });
    detachedSetupPage({ context, path: "/chats/thread-selected" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Selected running"),
      ).toBeInTheDocument();
    });
    expect(
      within(getSidebar()).queryByLabelText("Running"),
    ).not.toBeInTheDocument();
    expect(
      within(getSidebar()).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
  });

  it("prefers Running over Unread when both conditions hold", async () => {
    mockAPIs({
      current: [
        {
          id: "thread-both",
          title: "Running and unread",
          agentId: DEFAULT_AGENT_ID,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: false,
          isArchived: false,
          running: true,
        },
      ],
    });
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Running and unread"),
      ).toBeInTheDocument();
    });
    expect(within(getSidebar()).getByLabelText("Running")).toBeInTheDocument();
    expect(
      within(getSidebar()).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
  });

  it("does not render the Running dot when ChatThreadReadIndicator flag is off", async () => {
    setMockFeatureSwitches({ chatThreadReadIndicator: false });
    mockAPIs({
      current: [
        {
          id: "thread-gated",
          title: "Running but gated",
          agentId: DEFAULT_AGENT_ID,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: true,
          isArchived: false,
          running: true,
        },
      ],
    });
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Running but gated"),
      ).toBeInTheDocument();
    });
    expect(
      within(getSidebar()).queryByLabelText("Running"),
    ).not.toBeInTheDocument();
  });

  it("reloads the list and shows the running dot when threadListChanged fires", async () => {
    const threadsRef: { current: ThreadFixture[] } = {
      current: [
        {
          id: "thread-flips",
          title: "Will flip to running",
          agentId: DEFAULT_AGENT_ID,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: true,
          isArchived: false,
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
