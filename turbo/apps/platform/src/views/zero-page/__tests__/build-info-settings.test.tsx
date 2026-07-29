import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { afterEach, describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { initializeI18n } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../../i18n/resources.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

afterEach(async () => {
  document.documentElement.lang = DEFAULT_LOCALE;
  await initializeI18n(DEFAULT_LOCALE);
});

describe("build information settings", () => {
  it("shows build information in English", async () => {
    detachedSetupPage({
      context,
      path: "/?settings=debug",
      featureSwitches: {
        [FeatureSwitchKey.ZeroDebug]: true,
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

    detachedSetupPage({
      context,
      path: "/?settings=debug",
      featureSwitches: {
        [FeatureSwitchKey.ZeroDebug]: true,
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
