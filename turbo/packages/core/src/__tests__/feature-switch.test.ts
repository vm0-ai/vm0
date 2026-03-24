import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "../feature-switch-key";
import {
  isFeatureEnabled,
  getAllFeatureStates,
  computeEmailHash,
} from "../feature-switch";

describe("computeEmailHash", () => {
  it("should produce a consistent SHA-1 hex hash", async () => {
    const hash = await computeEmailHash("test@example.com");
    // SHA-1 produces a 40-character hex string
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("should lowercase the email before hashing", async () => {
    const lower = await computeEmailHash("test@example.com");
    const upper = await computeEmailHash("TEST@EXAMPLE.COM");
    const mixed = await computeEmailHash("Test@Example.Com");
    expect(lower).toBe(upper);
    expect(lower).toBe(mixed);
  });
});

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

  it("should return false for switch with enabledUserHashes but no enabledEmailHashes when only email provided", async () => {
    // AhrefsConnector has enabledUserHashes but no enabledEmailHashes
    await expect(
      isFeatureEnabled(
        FeatureSwitchKey.AhrefsConnector,
        undefined,
        "test@example.com",
      ),
    ).resolves.toBe(false);
  });
});

describe("getAllFeatureStates", () => {
  it("should return states for all feature switches", async () => {
    const states = await getAllFeatureStates();
    // Globally enabled switches should be true
    expect(states[FeatureSwitchKey.Dummy]).toBe(true);
    // Disabled switches without matching user/email should be false
    expect(states[FeatureSwitchKey.Pricing]).toBe(false);
  });
});
