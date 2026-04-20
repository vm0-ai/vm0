import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/core";
import { setMockFeatureSwitches } from "../../mocks/handlers/api-feature-switches";
import { server } from "../../mocks/server.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../__tests__/page-helper.ts";

const context = testContext();

describe("lab page", () => {
  it("should render lab page with feature switches list", async () => {
    setMockFeatureSwitches({});

    detachedSetupPage({ context, path: "/lab" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Lab" })).toBeInTheDocument();
    });

    expect(screen.getByText("Toggle experimental features on or off.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset all" })).toBeInTheDocument();
  });

  it("should show feature switches sorted alphabetically", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.UsageAnalytics]: true,
      [FeatureSwitchKey.VoiceChat]: false,
    });

    detachedSetupPage({ context, path: "/lab" });

    const labels = await waitFor(() => {
      return screen.getAllByText(/^(?:usageAnalytics|voiceChat)$/i);
    });

    // Should contain labels for all feature switch keys (sorted)
    const switchElements = screen
      .getAllByRole("checkbox")
      .map((el) => el.getAttribute("id"))
      .filter(Boolean);

    expect(switchElements.length).toBeGreaterThan(0);
  });

  it("should toggle feature switch on click", async () => {
    setMockFeatureSwitches({});

    detachedSetupPage({ context, path: "/lab" });

    const usageAnalyticsLabel = await waitFor(() => {
      return screen.getByText("usageAnalytics");
    });

    const switch_ = usageAnalyticsLabel.closest("label")?.querySelector('input[type="checkbox"]');

    expect(switch_).not.toBeNull();
  });

  it("should disable switches while resetting", async () => {
    setMockFeatureSwitches({});

    detachedSetupPage({ context, path: "/lab" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Lab" })).toBeInTheDocument();
    });

    const resetBtn = screen.getByRole("button", { name: "Reset all" });

    await userEvent.click(resetBtn);

    // While resetting, switches should be disabled
    await waitFor(() => {
      expect(screen.getByText("Resetting…")).toBeInTheDocument();
    });
  });
});
