import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "../feature-switch-key";
import { isFeatureEnabled, getAllFeatureStates } from "../feature-switch";

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

  it("should return false for email-gated switch with non-matching email", async () => {
    await expect(
      isFeatureEnabled(
        FeatureSwitchKey.GmailConnector,
        undefined,
        "random@example.com",
      ),
    ).resolves.toBe(false);
  });

  it("should return false for email-gated switch without email", async () => {
    await expect(
      isFeatureEnabled(FeatureSwitchKey.GmailConnector),
    ).resolves.toBe(false);
  });

  it("should return false for switch with enabledEmailHashes when no enabledEmailHashes configured", async () => {
    // AhrefsConnector has enabledUserHashes but no enabledEmailHashes
    await expect(
      isFeatureEnabled(
        FeatureSwitchKey.AhrefsConnector,
        undefined,
        "test@example.com",
      ),
    ).resolves.toBe(false);
  });

  it("should treat email case-insensitively by lowercasing before hashing", async () => {
    // Both should produce the same result since email is lowercased
    const resultLower = await isFeatureEnabled(
      FeatureSwitchKey.GmailConnector,
      undefined,
      "test@example.com",
    );
    const resultUpper = await isFeatureEnabled(
      FeatureSwitchKey.GmailConnector,
      undefined,
      "TEST@EXAMPLE.COM",
    );
    expect(resultLower).toBe(resultUpper);
  });
});

describe("getAllFeatureStates", () => {
  it("should return states for all feature switches", async () => {
    const states = await getAllFeatureStates();
    // Globally enabled switches should be true
    expect(states[FeatureSwitchKey.Dummy]).toBe(true);
    // Disabled switches without matching user/email should be false
    expect(states[FeatureSwitchKey.Pricing]).toBe(false);
    expect(states[FeatureSwitchKey.GmailConnector]).toBe(false);
  });

  it("should evaluate email hashes when email is provided", async () => {
    const statesWithoutEmail = await getAllFeatureStates();
    const statesWithEmail = await getAllFeatureStates(
      undefined,
      "nonmatching@example.com",
    );

    // Both should have same result for non-matching email
    expect(statesWithoutEmail[FeatureSwitchKey.GmailConnector]).toBe(false);
    expect(statesWithEmail[FeatureSwitchKey.GmailConnector]).toBe(false);

    // Globally enabled switches unaffected by email
    expect(statesWithEmail[FeatureSwitchKey.Dummy]).toBe(true);
  });
});
