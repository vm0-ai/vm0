import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("Build information is localized in debug settings", async () => {
  document.documentElement.lang = "pt-BR";
  context.mocks.data.userPreferences({ locale: "pt-BR" });

  await setupPage({
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
