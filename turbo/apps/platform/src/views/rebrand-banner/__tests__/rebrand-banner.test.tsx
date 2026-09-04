import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const REBRAND_MESSAGE = "VM0 is now Okou. Same team, same product, new name.";

describe("rebrand banner", () => {
  it("announces the new name on an Okou host until it is dismissed", async () => {
    context.mocks.browser.url("https://app.okou.ai/");
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.RebrandBanner]: true },
    });

    await waitFor(() => {
      expect(screen.getByText(REBRAND_MESSAGE)).toBeVisible();
    });

    click(screen.getByLabelText("Dismiss rename banner"));

    await waitFor(() => {
      expect(screen.queryByText(REBRAND_MESSAGE)).not.toBeInTheDocument();
    });
  });

  it("stays hidden on a VM0 host", async () => {
    context.mocks.browser.url("https://app.vm0.ai/");
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.RebrandBanner]: true },
    });

    await waitFor(() => {
      expect(document.querySelector(".zero-workspace-card")).not.toBeNull();
    });
    expect(screen.queryByText(REBRAND_MESSAGE)).not.toBeInTheDocument();
  });

  it("stays hidden while the feature switch is off", async () => {
    context.mocks.browser.url("https://app.okou.ai/");
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.RebrandBanner]: false },
    });

    await waitFor(() => {
      expect(document.querySelector(".zero-workspace-card")).not.toBeNull();
    });
    expect(screen.queryByText(REBRAND_MESSAGE)).not.toBeInTheDocument();
  });
});
