import { describe, it, expect } from "vitest";
import { isEnabled, FeatureSwitchKey } from "../feature-switch";
import { testContext } from "./test-helpers";

const context = testContext();

describe("feature-switch", () => {
  describe("isEnabled", () => {
    it("returns a computed signal", () => {
      const result = isEnabled(FeatureSwitchKey.Pricing);
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
    });

    it("resolves to false for Pricing when read via store", async () => {
      const { store } = context;
      const signal = isEnabled(FeatureSwitchKey.Pricing);
      const result = await store.get(signal);
      expect(result).toBeFalsy();
    });
  });

  describe("re-exports", () => {
    it("exports FeatureSwitchKey enum", () => {
      expect(FeatureSwitchKey.Pricing).toBe("pricing");
    });
  });
});
