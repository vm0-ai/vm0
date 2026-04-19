import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

const SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";

function createMockSchedule() {
  return {
    id: SCHEDULE_ID,
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Zero",
    name: "morning-briefing",
    triggerType: "cron",
    cronExpression: "0 9 * * 1-5",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Summarize yesterday's threads",
    description: "Daily morning briefing",
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    userId: "test-user-123",
    appendSystemPrompt: null,
    vars: null,
    secretNames: null,
    volumeVersions: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
  };
}

function mockAPIs(schedules = [createMockSchedule()]) {
  server.use(
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules });
    }),
  );
}

describe("zero schedule detail page", () => {
  it("should render schedule detail when navigating to /schedules/:id", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    // The detail page shows the description as the page title (appears in
    // breadcrumb, header, and sidebar, so use getAllByText).
    await waitFor(() => {
      expect(
        screen.getAllByText("Daily morning briefing")[0],
      ).toBeInTheDocument();
    });

    // Should NOT show the not-found screen
    expect(screen.queryByText("Schedule not found")).not.toBeInTheDocument();
  });

  it("should show not-found when schedule id does not match any schedule", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/schedules/f0000001-0000-4000-a000-999999999999",
    });

    await waitFor(() => {
      expect(screen.getByText("Schedule not found")).toBeInTheDocument();
    });
  });
});
