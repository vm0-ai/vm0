/**
 * Views tests for timezone-settings.tsx
 * Tests display rendering and timezone change interaction via the /settings route.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { getTimezoneLabel } from "../../../signals/zero-page/cron.ts";
import {
  type UserPreferencesResponse,
  zeroUserPreferencesContract,
} from "@vm0/core";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockPreferencesAPI(
  prefs: Omit<UserPreferencesResponse, "captureNetworkBodiesRemaining">,
) {
  setMockUserPreferences({
    captureNetworkBodiesRemaining: 0,
    ...prefs,
  });
}

async function openTimezoneTab() {
  detachedSetupPage({ context, path: "/settings" });
  click(await screen.findByText("Time Zone"));
  await waitFor(() => {
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
}

describe("timezone-settings - display", () => {
  it("shows list of available timezone options when dropdown opened (PREF-D-011)", async () => {
    mockPreferencesAPI({
      timezone: "Etc/UTC",
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    await openTimezoneTab();

    click(screen.getByRole("combobox"));

    await waitFor(() => {
      expect(screen.getByText(/Eastern Time \(ET\)/)).toBeInTheDocument();
      expect(
        screen.getByText(/Japan Standard Time \(JST\)/),
      ).toBeInTheDocument();
      expect(screen.getByText(/Pacific Time \(PT\)/)).toBeInTheDocument();
    });
  });

  it("disables select while timezone change is saving (PREF-D-012)", async () => {
    mockPreferencesAPI({
      timezone: "Etc/UTC",
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    server.use(
      mockApi(zeroUserPreferencesContract.update, ({ never }) => {
        return never();
      }),
    );
    await openTimezoneTab();

    click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(screen.getByText(/Eastern Time \(ET\)/)).toBeInTheDocument();
    });
    click(screen.getByText(/Eastern Time \(ET\)/));

    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeDisabled();
    });
  });

  it("hides select before preferences have loaded (PREF-D-013)", async () => {
    server.use(
      mockApi(zeroUserPreferencesContract.get, ({ never }) => {
        return never();
      }),
    );
    detachedSetupPage({ context, path: "/settings" });

    click(await screen.findByText("Time Zone"));

    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
  });

  it("shows browser default timezone when preferences has no timezone set (PREF-D-014)", async () => {
    mockPreferencesAPI({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    await openTimezoneTab();

    const browserTz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const expectedLabel = getTimezoneLabel(browserTz);

    await waitFor(() => {
      expect(screen.getByText(expectedLabel)).toBeInTheDocument();
    });
  });
});
