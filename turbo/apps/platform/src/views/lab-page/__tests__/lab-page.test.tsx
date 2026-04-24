import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

describe("lab page", () => {
  it("should render lab page with feature switches list", async () => {
    setMockFeatureSwitches({});

    detachedSetupPage({ context, path: "/_/lab" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Lab" })).toBeInTheDocument();
    });

    expect(
      screen.getByText("Toggle experimental features on or off."),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button").find((btn) => {
        return btn.textContent === "Reset all";
      }),
    ).toBeInTheDocument();
  });

  it("should show feature switches sorted alphabetically", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.UsageAnalytics]: true,
    });

    detachedSetupPage({ context, path: "/_/lab" });

    await waitFor(() => {
      return screen.getAllByText(/^(?:usageAnalytics|voiceChat)$/i);
    });

    // Should contain switch elements for feature switches
    const switchElements = screen.getAllByRole("switch");

    expect(switchElements.length).toBeGreaterThan(0);
  });

  it("should toggle feature switch on click", async () => {
    setMockFeatureSwitches({});

    detachedSetupPage({ context, path: "/_/lab" });

    await waitFor(() => {
      return screen.getByText("usageAnalytics");
    });

    const switchElements = screen.getAllByRole("switch");

    expect(switchElements.length).toBeGreaterThan(0);
  });

  it("should disable switches while resetting", async () => {
    setMockFeatureSwitches({});

    detachedSetupPage({ context, path: "/_/lab" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Lab" })).toBeInTheDocument();
    });

    const switches = screen.getAllByRole("switch");

    expect(
      switches.every((sw) => {
        return sw.getAttribute("disabled") === null;
      }),
    ).toBeTruthy();
  });
});
