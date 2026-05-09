/**
 * Tests for the mobile-native schedule detail layout (MobileNativeV1).
 *
 * The page replaces the desktop tabs / mobile <Select> dropdown with an
 * iOS-Settings-style index: schedule hero (calendar icon + summary title +
 * Active/Paused · time · next-run row), a primary "Run now" CTA, and a
 * grouped list of section rows (Settings, Instructions, Run History).
 * Tapping a row pushes that section's content via the existing ?tab=
 * query; the smart back arrow returns to the index without leaving
 * /schedules/:id.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { search } from "../../../signals/location.ts";

const context = testContext();
const mockApi = createMockApi(context);

const SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";

function mobileNativeOn(): Partial<Record<FeatureSwitchKey, boolean>> {
  return { [FeatureSwitchKey.MobileNativeV1]: true };
}

function mockMobileViewport() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    return {
      matches: query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as MediaQueryList;
  });
}

function mockAPIs() {
  setMockSchedules([
    createMockScheduleResponse({
      displayName: "Zero",
      timezone: "America/New_York",
      description: "Daily morning briefing",
    }),
  ]);
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads: [] });
    }),
  );
}

beforeEach(() => {
  mockMobileViewport();
});

describe("mobile-native schedule detail - index view (MOBILE-SCHED-001)", () => {
  it("renders hero, Run now CTA, and grouped section rows when MobileNativeV1 is on and no ?tab= is set", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: `/schedules/${SCHEDULE_ID}`,
      featureSwitches: mobileNativeOn(),
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("mobile-schedule-display-title"),
      ).toHaveTextContent("Daily morning briefing");
    });

    expect(screen.getByTestId("mobile-schedule-run-now")).toHaveTextContent(
      /Run now/i,
    );
    expect(
      screen.getByTestId("mobile-schedule-section-settings"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("mobile-schedule-section-instructions"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("mobile-schedule-section-history"),
    ).toBeInTheDocument();

    // Desktop tabs and the legacy mobile <Select> dropdown should NOT be in
    // the tree on mobile-native — the index list replaces both.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("does not show the index view when MobileNativeV1 is off — falls back to desktop tabs / legacy Select", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    await waitFor(() => {
      expect(
        screen.getAllByText("Daily morning briefing")[0],
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByTestId("mobile-schedule-section-settings"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab").length).toBeGreaterThan(0);
  });
});

describe("mobile-native schedule detail - row tap pushes section (MOBILE-SCHED-002)", () => {
  it("navigates from index to Instructions section when the Instructions row is tapped, updating ?tab=instructions", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: `/schedules/${SCHEDULE_ID}`,
      featureSwitches: mobileNativeOn(),
    });

    const row = await waitFor(() => {
      return screen.getByTestId("mobile-schedule-section-instructions");
    });

    click(row);

    await waitFor(() => {
      expect(search()).toBe("?tab=instructions");
    });
    expect(
      screen.getByTestId("mobile-schedule-section-view"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("mobile-schedule-section-instructions"),
    ).not.toBeInTheDocument();
  });
});

describe("mobile-native schedule detail - top bar back arrow returns to index (MOBILE-SCHED-003)", () => {
  it("clears ?tab= and re-renders the index when the smart back arrow is tapped inside a section", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: `/schedules/${SCHEDULE_ID}?tab=history`,
      featureSwitches: mobileNativeOn(),
    });

    const back = await waitFor(() => {
      return screen.getByTestId("mobile-back-to-schedule-overview");
    });

    click(back);

    await waitFor(() => {
      expect(search()).toBe("");
    });
    expect(
      screen.getByTestId("mobile-schedule-section-history"),
    ).toBeInTheDocument();
  });
});

describe("mobile-native schedule detail - top bar shows section title in section view (MOBILE-SCHED-004)", () => {
  it("centers the section label in the top bar instead of the schedule name when ?tab= is set", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: `/schedules/${SCHEDULE_ID}?tab=history`,
      featureSwitches: mobileNativeOn(),
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("mobile-back-to-schedule-overview"),
      ).toBeInTheDocument();
    });

    const topBar = screen.getByTestId("mobile-back-to-schedule-overview")
      .parentElement as HTMLElement;
    expect(topBar).toHaveTextContent(/Run History/i);
    expect(topBar).not.toHaveTextContent("Daily morning briefing");
  });
});
