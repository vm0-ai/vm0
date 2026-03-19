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

  it("should return true for email-gated switch with matching email", async () => {
    // testreviewer@example.com has SHA-1 086eee0974906eb383d645ade1d76c806278ded1
    // which is in GOOGLE_OAUTH_REVIEWER_EMAIL_HASHES
    await expect(
      isFeatureEnabled(
        FeatureSwitchKey.GmailConnector,
        undefined,
        "testreviewer@example.com",
      ),
    ).resolves.toBe(true);
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
    // testreviewer@example.com matches a hash in GOOGLE_OAUTH_REVIEWER_EMAIL_HASHES
    // Both casing variants should return true, proving lowercasing works for matches
    await expect(
      isFeatureEnabled(
        FeatureSwitchKey.GmailConnector,
        undefined,
        "testreviewer@example.com",
      ),
    ).resolves.toBe(true);
    await expect(
      isFeatureEnabled(
        FeatureSwitchKey.GmailConnector,
        undefined,
        "TESTREVIEWER@EXAMPLE.COM",
      ),
    ).resolves.toBe(true);
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
    const statesWithNonMatching = await getAllFeatureStates(
      undefined,
      "nonmatching@example.com",
    );
    const statesWithMatching = await getAllFeatureStates(
      undefined,
      "testreviewer@example.com",
    );

    // Non-matching email should not enable email-gated switches
    expect(statesWithoutEmail[FeatureSwitchKey.GmailConnector]).toBe(false);
    expect(statesWithNonMatching[FeatureSwitchKey.GmailConnector]).toBe(false);

    // Matching email should enable email-gated switches
    expect(statesWithMatching[FeatureSwitchKey.GmailConnector]).toBe(true);

    // Globally enabled switches unaffected by email
    expect(statesWithMatching[FeatureSwitchKey.Dummy]).toBe(true);
  });
});
