import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "../feature-switch-key";
import { isFeatureEnabled } from "../feature-switch";

describe("isFeatureEnabled", () => {
  it("should return true for globally enabled switch", async () => {
    await expect(isFeatureEnabled(FeatureSwitchKey.Dummy)).resolves.toBe(true);
  });

  it("should return true for globally enabled switch even with userId", async () => {
    await expect(
      isFeatureEnabled(FeatureSwitchKey.Dummy, "any-user"),
    ).resolves.toBe(true);
  });

  it("should return false for disabled switch without userId", async () => {
    await expect(isFeatureEnabled(FeatureSwitchKey.Pricing)).resolves.toBe(
      false,
    );
  });

  it("should return false for disabled switch with userId when no enabledUserHashes configured", async () => {
    await expect(
      isFeatureEnabled(FeatureSwitchKey.Pricing, "some-user"),
    ).resolves.toBe(false);
  });
});
