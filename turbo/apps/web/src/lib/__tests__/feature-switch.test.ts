import { describe, it, expect } from "vitest";
import { isFeatureEnabled, FeatureSwitchKey } from "../feature-switch";

describe("feature-switch", () => {
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

  describe("FeatureSwitchKey re-export", () => {
    it("exports FeatureSwitchKey enum", () => {
      expect(FeatureSwitchKey.Pricing).toBe("pricing");
    });
  });
});
