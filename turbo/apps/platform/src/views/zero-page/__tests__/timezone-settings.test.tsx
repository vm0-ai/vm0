/**
 * Views tests for timezone-settings.tsx
 * Tests display rendering and timezone change interaction via the /settings route.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { getTimezoneLabel } from "../../../signals/zero-page/cron.ts";
import type { UserPreferencesResponse } from "@vm0/core";

const context = testContext();

function mockPreferencesAPI(
  prefs: Omit<UserPreferencesResponse, "captureNetworkBodiesRemaining">,
) {
  const full: UserPreferencesResponse = {
    captureNetworkBodiesRemaining: 0,
    ...prefs,
  };
  server.use(
    http.get("*/api/zero/user-preferences", () => {
      return HttpResponse.json(full);
    }),
  );
}

async function openTimezoneTab(user: ReturnType<typeof userEvent.setup>) {
  await setupPage({ context, path: "/settings" });
  await user.click(await screen.findByText("Time Zone"));
  await waitFor(() => {
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
}

describe("timezone-settings - display", () => {
  it("shows list of available timezone options when dropdown opened (PREF-D-011)", async () => {
    const user = userEvent.setup();
    mockPreferencesAPI({
      timezone: "Etc/UTC",
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    await openTimezoneTab(user);

    await user.click(screen.getByRole("combobox"));

    await waitFor(() => {
      expect(screen.getByText(/Eastern Time \(ET\)/)).toBeInTheDocument();
      expect(
        screen.getByText(/Japan Standard Time \(JST\)/),
      ).toBeInTheDocument();
      expect(screen.getByText(/Pacific Time \(PT\)/)).toBeInTheDocument();
    });
  });

  it("disables select while timezone change is saving (PREF-D-012)", async () => {
    const user = userEvent.setup();
    mockPreferencesAPI({
      timezone: "Etc/UTC",
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    server.use(
      http.post("*/api/zero/user-preferences", () => {
        return new Promise(() => {});
      }),
    );
    await openTimezoneTab(user);

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(screen.getByText(/Eastern Time \(ET\)/)).toBeInTheDocument();
    });
    await user.click(screen.getByText(/Eastern Time \(ET\)/));

    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeDisabled();
    });
  });

  it("hides select before preferences have loaded (PREF-D-013)", async () => {
    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return new Promise(() => {});
      }),
    );
    const user = userEvent.setup();
    await setupPage({ context, path: "/settings" });

    await user.click(await screen.findByText("Time Zone"));

    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
  });

  it("shows browser default timezone when preferences has no timezone set (PREF-D-014)", async () => {
    const user = userEvent.setup();
    mockPreferencesAPI({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    await openTimezoneTab(user);

    const browserTz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const expectedLabel = getTimezoneLabel(browserTz);

    await waitFor(() => {
      expect(screen.getByText(expectedLabel)).toBeInTheDocument();
    });
  });
});
