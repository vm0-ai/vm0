import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";
import { server } from "../../../mocks/server.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { zeroSchedulesMainContract } from "@vm0/api-contracts/contracts/zero-schedules";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

const context = testContext();
const mockApi = createMockApi(context);

const SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";

function mockAPIs(
  schedules = [
    createMockScheduleResponse({
      displayName: "Zero",
      description: "Daily morning briefing",
    }),
  ],
) {
  setMockSchedules(schedules);
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

describe("zero schedule detail page — personal provider checkbox", () => {
  it("hides the checkbox when feature switch is off", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    await waitFor(() => {
      expect(
        screen.getAllByText("Daily morning briefing")[0],
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByLabelText(/use personal provider/i),
    ).not.toBeInTheDocument();
  });

  it("shows the checkbox when feature switch is on", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: `/schedules/${SCHEDULE_ID}`,
      featureSwitches: { [FeatureSwitchKey.PersonalModelProvider]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText(/use personal provider/i),
      ).toBeInTheDocument();
    });
  });

  it("includes preferPersonalProvider in the deploy body when toggled and saved", async () => {
    mockAPIs();
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
        capturedBody = body as Record<string, unknown>;
        return respond(200, {
          schedule: createMockScheduleResponse({
            preferPersonalProvider: true,
          }),
          created: false,
        });
      }),
    );

    detachedSetupPage({
      context,
      path: `/schedules/${SCHEDULE_ID}`,
      featureSwitches: { [FeatureSwitchKey.PersonalModelProvider]: true },
    });

    const checkbox = await screen.findByLabelText(/use personal provider/i);
    click(checkbox);

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByText(/^Save$/i));

    await waitFor(() => {
      expect(capturedBody?.preferPersonalProvider).toBeTruthy();
    });
  });
});
