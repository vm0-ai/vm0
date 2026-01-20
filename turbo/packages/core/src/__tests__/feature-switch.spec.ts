import { describe, it, expect } from "vitest";
import {
  FeatureSwitchKey,
  PricingSwitch,
  getFeatureSwitch,
  isFeatureEnabled,
} from "../index";

describe("feature-switch", () => {
  describe("FeatureSwitchKey", () => {
    it("has Pricing value", () => {
      expect(FeatureSwitchKey.Pricing).toBe("pricing");
    });
  });

  describe("PricingSwitch", () => {
    it("has correct key", () => {
      expect(PricingSwitch.key).toBe(FeatureSwitchKey.Pricing);
    });

    it("has correct maintainer", () => {
      expect(PricingSwitch.maintainer).toBe("ethan@vm0.ai");
    });

    it("is disabled by default", () => {
      expect(PricingSwitch.enabled).toBe(false);
    });
  });

  describe("getFeatureSwitch", () => {
    it("returns PricingSwitch for Pricing key", () => {
      const result = getFeatureSwitch(FeatureSwitchKey.Pricing);
      expect(result).toBe(PricingSwitch);
    });
  });

  describe("isFeatureEnabled", () => {
    it("returns a Promise", () => {
      const result = isFeatureEnabled(FeatureSwitchKey.Pricing);
      expect(result).toBeInstanceOf(Promise);
    });

    it("resolves to false for Pricing", async () => {
      const result = await isFeatureEnabled(FeatureSwitchKey.Pricing);
      expect(result).toBe(false);
    });
  });
});
