import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function makeLogsResponse(
  data: {
    id: string;
    agentId: string;
    displayName: string;
    status: string;
  }[],
) {
  return {
    data: data.map((d) => ({
      ...d,
      sessionId: `session-${d.id}`,
      orgSlug: "test",
      framework: "claude-code",
      triggerSource: "web",
      triggerAgentName: null,
      scheduleId: null,
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:10Z",
    })),
    pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
    filters: { statuses: ["completed"], sources: ["web"], agents: ["zero"] },
  };
}

function mockCommonAPIs() {
  server.use(
    http.get("*/api/zero/composes/list", () => {
      return HttpResponse.json({
        composes: [
          {
            id: "c0000000-0000-4000-a000-000000000001",
            name: "zero",
            displayName: "Zero",
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
          },
        ],
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("activity list refresh on navigation", () => {
  it("should refresh data when navigating back to the activity page", async () => {
    const user = userEvent.setup();
    let fetchCount = 0;

    mockCommonAPIs();

    server.use(
      http.get("*/api/zero/logs", () => {
        fetchCount++;
        return HttpResponse.json(
          makeLogsResponse([
            {
              id: `run-${fetchCount}`,
              agentId: "zero",
              displayName: "Zero",
              status: "completed",
            },
          ]),
        );
      }),
    );

    // Navigate to activity page
    await setupPage({ context, path: "/activity" });

    // Wait for the activity heading and list data to render
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Activity" }),
      ).toBeInTheDocument();
      expect(screen.getAllByText("Zero").length).toBeGreaterThanOrEqual(1);
    });

    const initialFetchCount = fetchCount;

    // Navigate to team page via sidebar
    const teamLink = screen.getByText("Agents").closest("a");
    expect(teamLink).not.toBeNull();
    await user.click(teamLink!);

    // Wait for team page to render
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Activity" }),
      ).not.toBeInTheDocument();
    });

    // Navigate back to activity page
    const activityLink = screen.getByText("Activity logs").closest("a");
    expect(activityLink).not.toBeNull();
    await user.click(activityLink!);

    // Wait for the list to render again
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Activity" }),
      ).toBeInTheDocument();
    });

    // Wait for data to be fetched again
    await waitFor(() => {
      expect(screen.getAllByText("Zero").length).toBeGreaterThanOrEqual(1);
    });

    // Verify that a new fetch was triggered after re-navigation
    expect(fetchCount).toBeGreaterThan(initialFetchCount);
  }, 20_000);
});
