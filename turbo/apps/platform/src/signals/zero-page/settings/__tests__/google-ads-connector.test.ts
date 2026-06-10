import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { setupPage } from "../../../../__tests__/page-helper.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { allConnectorTypes$ } from "../connectors.ts";

const context = testContext();

describe("marketing connectors", () => {
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

  it("shows Meta Ads by default", async () => {
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const connectors = await context.store.get(allConnectorTypes$);
    const metaAds = connectors.find((connector) => {
      return connector.type === "meta-ads";
    });

    expect(metaAds?.label).toBe("Meta Ads");
    expect(metaAds?.availableAuthMethods).toStrictEqual(["oauth"]);
  });

  it("hides Meta Ads when its feature switch is disabled", async () => {
    await setupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.MetaAdsConnector]: false },
      withoutRender: true,
    });

    const connectors = await context.store.get(allConnectorTypes$);
    const metaAds = connectors.find((connector) => {
      return connector.type === "meta-ads";
    });

    expect(metaAds).toBeUndefined();
  });

  it("shows Google Search Console by default without an experimental label", async () => {
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const connectors = await context.store.get(allConnectorTypes$);
    const googleSearchConsole = connectors.find((connector) => {
      return connector.type === "google-search-console";
    });

    expect(googleSearchConsole?.label).toBe("Google Search Console");
    expect(googleSearchConsole?.availableAuthMethods).toStrictEqual(["oauth"]);
  });

  it("hides Google Search Console when its feature switch is disabled", async () => {
    await setupPage({
      context,
      path: "/",
      featureSwitches: {
        [FeatureSwitchKey.GoogleSearchConsoleConnector]: false,
      },
      withoutRender: true,
    });

    const connectors = await context.store.get(allConnectorTypes$);
    const googleSearchConsole = connectors.find((connector) => {
      return connector.type === "google-search-console";
    });

    expect(googleSearchConsole).toBeUndefined();
  });
});
