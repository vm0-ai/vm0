/**
 * Tests for zero-account-hub-page.tsx — the mobile-native account hub
 * reached from the workspace drawer's user identity card.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";

const context = testContext();

function setupAccountHub() {
  setMockUserPreferences({
    timezone: null,
    pinnedAgentIds: [],
    sendMode: "enter",
    captureNetworkBodiesRemaining: 0,
  });
  detachedSetupPage({ context, path: "/account" });
}

describe("account hub - lists core account menu items (ACCOUNT-HUB-001)", () => {
  it("renders Preferences, Usage, Manage account, Add account, and Sign out", async () => {
    setupAccountHub();

    await waitFor(() => {
      expect(screen.getByTestId("account-hub-page")).toBeInTheDocument();
    });
    expect(screen.getByTestId("account-hub-preferences")).toBeInTheDocument();
    expect(screen.getByTestId("account-hub-usage")).toBeInTheDocument();
    expect(screen.getByTestId("account-hub-manage")).toBeInTheDocument();
    expect(screen.getByTestId("account-hub-add")).toBeInTheDocument();
    expect(screen.getByTestId("account-hub-signout")).toBeInTheDocument();
  });
});

describe("account hub - Preferences row navigates to /settings (ACCOUNT-HUB-002)", () => {
  it("routes to /settings when Preferences is tapped", async () => {
    setupAccountHub();

    const preferences = await waitFor(() => {
      return screen.getByTestId("account-hub-preferences");
    });
    click(preferences);

    await waitFor(() => {
      expect(pathname()).toBe("/settings");
    });
  });
});

describe("account hub - Usage row navigates to /_/usage (ACCOUNT-HUB-003)", () => {
  it("routes to /_/usage when Usage is tapped", async () => {
    setupAccountHub();

    const usage = await waitFor(() => {
      return screen.getByTestId("account-hub-usage");
    });
    click(usage);

    await waitFor(() => {
      expect(pathname()).toBe("/_/usage");
    });
  });
});
