/**
 * Views tests for zero-unsaved-bar.tsx
 * Tests unsaved changes indicator, save/discard button behavior, and loading state.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

const SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";

function createMockSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULE_ID,
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Zero",
    name: "morning-briefing",
    triggerType: "cron",
    cronExpression: "0 9 * * 1-5",
    atTime: null,
    intervalSeconds: null,
    timezone: "America/New_York",
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
    modelProviderId: null,
    selectedModel: null,
    ...overrides,
  };
}

function mockAPIs(overrides: Record<string, unknown> = {}) {
  server.use(
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules: [createMockSchedule(overrides)] });
    }),
  );
}

async function loadAndMakeDirty(user: ReturnType<typeof userEvent.setup>) {
  detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
  await waitFor(() => {
    expect(
      screen.getByPlaceholderText("Leave blank to auto-generate"),
    ).toBeInTheDocument();
  });
  await user.type(
    screen.getByPlaceholderText("Leave blank to auto-generate"),
    "My description",
  );
}

describe("zero unsaved bar - unsaved changes indicator (SCHED-D-093)", () => {
  it("shows unsaved changes indicator when settings form is dirty", async () => {
    const user = userEvent.setup();
    mockAPIs();
    await loadAndMakeDirty(user);

    await waitFor(() => {
      expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument();
    });
  });
});

describe("zero unsaved bar - discard button reverts changes (SCHED-D-095)", () => {
  it("hides unsaved changes bar when Discard is clicked", async () => {
    const user = userEvent.setup();
    mockAPIs();
    await loadAndMakeDirty(user);

    await waitFor(() => {
      expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("discard-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
    });
  });
});

describe("zero unsaved bar - save button persists changes (SCHED-D-096)", () => {
  it("hides unsaved changes bar after successful save", async () => {
    server.use(
      http.post("*/api/zero/schedules", () => {
        return HttpResponse.json({
          schedule: createMockSchedule({
            description: "Daily morning briefingMy description",
          }),
          created: false,
        });
      }),
    );

    const user = userEvent.setup();
    mockAPIs();
    await loadAndMakeDirty(user);

    await waitFor(() => {
      expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("save-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
    });
  });
});
