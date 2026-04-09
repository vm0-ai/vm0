import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

describe("schedule page", () => {
  it("should render the schedule page with empty schedules", async () => {
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    });

    // Empty state shows "No runs scheduled"
    expect(screen.getByText("No runs scheduled")).toBeInTheDocument();
  });

  it("should render schedule entries when data is present", async () => {
    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({
          schedules: [
            {
              id: "f0000002-0000-4000-a000-000000000001",
              agentId: "c0000000-0000-4000-a000-000000000001",
              displayName: null,
              name: "test-schedule",
              triggerType: "cron",
              cronExpression: "0 9 * * *",
              atTime: null,
              intervalSeconds: null,
              timezone: "UTC",
              prompt: "Daily standup summary",
              description: null,
              enabled: true,
              nextRunAt: null,
              lastRunAt: null,
              createdAt: "2026-03-01T00:00:00Z",
              updatedAt: "2026-03-01T00:00:00Z",
              userId: "test-user-123",
              appendSystemPrompt: null,
              vars: null,
              secretNames: null,
              artifactName: null,
              artifactVersion: null,
              volumeVersions: null,
              retryStartedAt: null,
              consecutiveFailures: 0,
            },
          ],
        });
      }),
    );

    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(
        screen.getAllByText("Daily standup summary")[0],
      ).toBeInTheDocument();
    });
  });

  it("should show Add schedule button", async () => {
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    });

    // The "Add schedule" button appears in the header and in the empty state
    const addButtons = screen.getAllByRole("button").filter((el) => {
      return /Add schedule/.test(el.textContent ?? "");
    });
    expect(addButtons.length).toBeGreaterThanOrEqual(1);
  });
});
