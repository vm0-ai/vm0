import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "../feature-switch-key";
import {
  isFeatureEnabled,
  getAllFeatureStates,
  computeEmailHash,
  computeOrgIdHash,
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

describe("computeOrgIdHash", () => {
  it("should produce a consistent SHA-1 hex hash", async () => {
    const hash = await computeOrgIdHash("org_test123");
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    // Same input should produce the same hash
    const hash2 = await computeOrgIdHash("org_test123");
    expect(hash).toBe(hash2);
  });

  it("should not lowercase the orgId before hashing", async () => {
    const upper = await computeOrgIdHash("ABC");
    const lower = await computeOrgIdHash("abc");
    expect(upper).not.toBe(lower);
  });
});

describe("isFeatureEnabled", () => {
  it("should return true for globally enabled switch", async () => {
    await expect(isFeatureEnabled(FeatureSwitchKey.Dummy)).resolves.toBe(true);
  });

  it("should return true for globally enabled switch even with context", async () => {
    await expect(
      isFeatureEnabled(FeatureSwitchKey.Dummy, { userId: "any-user" }),
    ).resolves.toBe(true);
  });

  it("should return false for disabled switch without context", async () => {
    await expect(isFeatureEnabled(FeatureSwitchKey.Pricing)).resolves.toBe(
      false,
    );
  });

  it("should return false for disabled switch with non-matching userId", async () => {
    await expect(
      isFeatureEnabled(FeatureSwitchKey.Pricing, { userId: "some-user" }),
    ).resolves.toBe(false);
  });

  it("should return false for switch with enabledUserHashes but no enabledEmailHashes when only email provided", async () => {
    // AhrefsConnector has enabledUserHashes but no enabledEmailHashes
    await expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        email: "test@example.com",
      }),
    ).resolves.toBe(false);
  });

  it("should return true when orgId hash matches enabledOrgIdHashes", async () => {
    // AhrefsConnector has enabledOrgIdHashes: STAFF_ORG_ID_HASHES
    await expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      }),
    ).resolves.toBe(true);
  });

  it("should return false when orgId does not match enabledOrgIdHashes", async () => {
    await expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        orgId: "org_nonexistent",
      }),
    ).resolves.toBe(false);
  });

  it("should return false when no orgId provided but switch has enabledOrgIdHashes", async () => {
    await expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector),
    ).resolves.toBe(false);
  });

  it("should return true when orgId matches even if userId does not", async () => {
    await expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        userId: "non-matching-user",
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      }),
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
  });

  it("should enable switches when orgId matches enabledOrgIdHashes", async () => {
    const states = await getAllFeatureStates({
      orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    });
    // Switches with STAFF_ORG_ID_HASHES should be true
    expect(states[FeatureSwitchKey.Pricing]).toBe(true);
    expect(states[FeatureSwitchKey.AhrefsConnector]).toBe(true);
    // Globally enabled should still be true
    expect(states[FeatureSwitchKey.Dummy]).toBe(true);
    // Switches without org hashes should remain false
    expect(states[FeatureSwitchKey.Secrets]).toBe(false);
  });

  it("should return false for switches with orgId hashes when orgId does not match", async () => {
    const states = await getAllFeatureStates({
      orgId: "org_nonexistent",
    });
    expect(states[FeatureSwitchKey.Pricing]).toBe(false);
    expect(states[FeatureSwitchKey.AhrefsConnector]).toBe(false);
  });
});
