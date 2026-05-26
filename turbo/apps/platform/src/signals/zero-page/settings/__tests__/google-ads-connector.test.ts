import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { setupPage } from "../../../../__tests__/page-helper.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { allConnectorTypes$ } from "../connectors.ts";

const context = testContext();

describe("google ads connector", () => {
  it("shows Google Ads by default", async () => {
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const connectors = await context.store.get(allConnectorTypes$);
    const googleAds = connectors.find((connector) => {
      return connector.type === "google-ads";
    });

    expect(googleAds?.label).toBe("Google Ads");
    expect(googleAds?.availableAuthMethods).toStrictEqual(["oauth"]);
  });

  it("is hidden when the Google Ads connector feature switch is disabled", async () => {
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { [FeatureSwitchKey.GoogleAdsConnector]: false },
    });

    const connectors = await context.store.get(allConnectorTypes$);

    expect(
      connectors.some((connector) => {
        return connector.type === "google-ads";
      }),
    ).toBeFalsy();
  });
});
