import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

describe("build information settings", () => {
  it("shows build information in English", async () => {
    detachedSetupPage({
      context,
      path: "/?settings=debug",
      featureSwitches: {
        [FeatureSwitchKey.OkouDebug]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Build information")).toBeInTheDocument();
    });
    expect(screen.getByText("Frontend")).toBeInTheDocument();
    expect(screen.getByText("Backend")).toBeInTheDocument();
    expect(screen.getAllByText("Commit SHA")).toHaveLength(2);
  });

  it("shows build information in Brazilian Portuguese", async () => {
    document.documentElement.lang = "pt-BR";
    context.mocks.data.userPreferences({ locale: "pt-BR" });

    detachedSetupPage({
      context,
      path: "/?settings=debug",
      featureSwitches: {
        [FeatureSwitchKey.OkouDebug]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Informações da compilação")).toBeInTheDocument();
    });
    expect(screen.getByText("Frontend")).toBeInTheDocument();
    expect(screen.getByText("Backend")).toBeInTheDocument();
    expect(screen.getAllByText("SHA do commit")).toHaveLength(2);
  });
});
