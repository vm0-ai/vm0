import { describe, it, expect } from "vitest";
import { isEnabled, FeatureSwitchKey } from "../feature-switch";

describe("feature-switch", () => {
  describe("isEnabled", () => {
    it("returns a Promise", () => {
      const result = isEnabled(FeatureSwitchKey.Pricing);
      expect(result).toBeInstanceOf(Promise);
    });

    it("resolves to false for Pricing", async () => {
      const result = await isEnabled(FeatureSwitchKey.Pricing);
      expect(result).toBe(false);
    });
  });

  describe("FeatureSwitchKey re-export", () => {
    it("exports FeatureSwitchKey enum", () => {
      expect(FeatureSwitchKey.Pricing).toBe("pricing");
    });
  });
});
