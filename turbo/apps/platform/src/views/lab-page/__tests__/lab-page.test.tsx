import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function featureSwitchControl(feature: FeatureSwitchKey): HTMLElement {
  const label = screen.getByText(feature).closest("label");
  if (!(label instanceof HTMLElement)) {
    throw new Error(`${feature} feature row not found`);
  }
  return within(label).getByRole("switch");
}

describe("lab page", () => {
  it("lets users toggle and reset feature switches", async () => {
    let switches: Partial<Record<FeatureSwitchKey, boolean>> = {
      [FeatureSwitchKey.Lab]: true,
      [FeatureSwitchKey.AwsConnector]: false,
    };
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, { switches });
    });
    context.mocks.api(
      zeroFeatureSwitchesContract.update,
      ({ body, respond }) => {
        switches = { ...switches, ...body.switches };
        return respond(200, { switches: body.switches });
      },
    );
    context.mocks.api(zeroFeatureSwitchesContract.delete, ({ respond }) => {
      switches = {};
      return respond(200, { deleted: true });
    });

    detachedSetupPage({ context, path: "/_/lab" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Lab" })).toBeInTheDocument();
      expect(screen.getByText("Other")).toBeInTheDocument();
      expect(screen.getAllByText("Connectors").length).toBeGreaterThan(0);
    });

    const awsSwitch = featureSwitchControl(FeatureSwitchKey.AwsConnector);
    expect(awsSwitch).toHaveAttribute("aria-checked", "false");

    click(awsSwitch);

    await waitFor(() => {
      expect(
        featureSwitchControl(FeatureSwitchKey.AwsConnector),
      ).toHaveAttribute("aria-checked", "true");
    });

    click(screen.getByText("Reset all"));

    await waitFor(() => {
      expect(
        featureSwitchControl(FeatureSwitchKey.AwsConnector),
      ).toHaveAttribute("aria-checked", "false");
    });
  });
});
