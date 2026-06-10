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

  it("hides Meta Ads by default", async () => {
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const connectors = await context.store.get(allConnectorTypes$);
    const metaAds = connectors.find((connector) => {
      return connector.type === "meta-ads";
    });

    expect(metaAds).toBeUndefined();
  });

  it("shows Meta Ads when its feature switch is enabled", async () => {
    await setupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.MetaAdsConnector]: true },
      withoutRender: true,
    });

    const connectors = await context.store.get(allConnectorTypes$);
    const metaAds = connectors.find((connector) => {
      return connector.type === "meta-ads";
    });

    expect(metaAds?.label).toBe("Meta Ads");
    expect(metaAds?.availableAuthMethods).toStrictEqual(["oauth"]);
  });
});
