/**
 * Tests for the zeroAutomations surface gating on zero-schedule-page.tsx.
 *
 * Surface-only gating: when the switch is OFF the page stays "Schedules" and
 * talks to /api/zero/schedules; when ON it presents as "Automations" and talks
 * to /api/automations. There is no execution-path fork — the two surfaces are
 * the same service, so behavior is otherwise identical.
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  automationsMainContract,
  type AutomationResponse,
} from "@vm0/api-contracts/contracts/automations";
import {
  zeroSchedulesMainContract,
  type ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";

const context = testContext();
const mockApi = createMockApi(context);

function seededSchedule(): ScheduleResponse {
  return createMockScheduleResponse({
    id: "f0000001-0000-4000-a000-000000000001",
    name: "morning-briefing",
    cronExpression: "0 9 * * 1-5",
    prompt: "Summarize yesterday's threads",
  });
}

describe("zero schedule page - automations surface gating", () => {
  it("stays labeled Schedules when the switch is OFF (AUTO-SURFACE-001)", async () => {
    setMockSchedules([seededSchedule()]);
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Automated tasks scheduled across all agents in your workspace.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Add schedule")).toBeInTheDocument();
    expect(screen.queryByText("Automations")).not.toBeInTheDocument();
  });

  it("presents as Automations when the switch is ON (AUTO-SURFACE-002)", async () => {
    setMockSchedules([seededSchedule()]);
    detachedSetupPage({
      context,
      path: "/schedules",
      featureSwitches: { zeroAutomations: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Automations")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Automations running across all agents in your workspace.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Add automation")).toBeInTheDocument();
    expect(screen.queryByText("Scheduled tasks")).not.toBeInTheDocument();
  });

  it("loads entries from the automations endpoint when ON (AUTO-SURFACE-003)", async () => {
    // Only the automations endpoint returns an entry; the legacy schedules
    // endpoint returns nothing. The page must render the automation, proving it
    // talks to /api/automations rather than /api/zero/schedules.
    const automation: AutomationResponse = {
      ...seededSchedule(),
      name: "automation-only",
      prompt: "Visible only via the automations endpoint",
    };
    server.use(
      mockApi(automationsMainContract.list, ({ respond }) => {
        return respond(200, { automations: [automation] });
      }),
      mockApi(zeroSchedulesMainContract.list, ({ respond }) => {
        return respond(200, { schedules: [] });
      }),
    );

    detachedSetupPage({
      context,
      path: "/schedules",
      featureSwitches: { zeroAutomations: true },
    });

    await waitFor(() => {
      expect(
        screen.getAllByText("Visible only via the automations endpoint").length,
      ).toBeGreaterThan(0);
    });
  });
});
