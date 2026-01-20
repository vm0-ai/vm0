import { describe, it, expect } from "vitest";
import { useFeature, FeatureSwitchKey } from "../feature-switch";

describe("feature-switch", () => {
  describe("useFeature", () => {
    it("returns a Promise", () => {
      const result = useFeature(FeatureSwitchKey.Pricing);
      expect(result).toBeInstanceOf(Promise);
    });

    it("resolves to false for Pricing", async () => {
      const result = await useFeature(FeatureSwitchKey.Pricing);
      expect(result).toBe(false);
    });
  });

  describe("FeatureSwitchKey re-export", () => {
    it("exports FeatureSwitchKey enum", () => {
      expect(FeatureSwitchKey.Pricing).toBe("pricing");
    });
  });
});
