import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "../feature-switch-key";
import {
  isFeatureEnabled,
  getAllFeatureStates,
  computeEmailHash,
  computeOrgIdHash,
} from "../feature-switch";

describe("computeEmailHash", () => {
  it("should produce a consistent FNV-1a hex hash", () => {
    const hash = computeEmailHash("test@example.com");
    // FNV-1a 32-bit produces an 8-character hex string
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("should lowercase the email before hashing", () => {
    const lower = computeEmailHash("test@example.com");
    const upper = computeEmailHash("TEST@EXAMPLE.COM");
    const mixed = computeEmailHash("Test@Example.Com");
    expect(lower).toBe(upper);
    expect(lower).toBe(mixed);
  });
});

describe("computeOrgIdHash", () => {
  it("should produce a consistent FNV-1a hex hash", () => {
    const hash = computeOrgIdHash("org_test123");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    // Same input should produce the same hash
    const hash2 = computeOrgIdHash("org_test123");
    expect(hash).toBe(hash2);
  });

  it("should not lowercase the orgId before hashing", () => {
    const upper = computeOrgIdHash("ABC");
    const lower = computeOrgIdHash("abc");
    expect(upper).not.toBe(lower);
  });
});

describe("isFeatureEnabled", () => {
  it("should return true for globally enabled switch", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Dummy)).toBe(true);
  });

  it("should return true for globally enabled switch even with context", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Dummy, { userId: "any-user" }),
    ).toBe(true);
  });

  it("should return false for disabled switch without context", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.AhrefsConnector)).toBe(false);
  });

  it("should return false for disabled switch with non-matching userId", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        userId: "some-user",
      }),
    ).toBe(false);
  });

  it("should return false for switch with enabledUserHashes but no enabledEmailHashes when only email provided", () => {
    // AhrefsConnector has enabledUserHashes but no enabledEmailHashes
    expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        email: "test@example.com",
      }),
    ).toBe(false);
  });

  it("should return true when orgId hash matches enabledOrgIdHashes", () => {
    // AhrefsConnector has enabledOrgIdHashes: STAFF_ORG_ID_HASHES
    expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      }),
    ).toBe(true);
  });

  it("should return false when orgId does not match enabledOrgIdHashes", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        orgId: "org_nonexistent",
      }),
    ).toBe(false);
  });

  it("should return false when no orgId provided but switch has enabledOrgIdHashes", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.AhrefsConnector)).toBe(false);
  });

  it("should return true when orgId matches even if userId does not", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        userId: "non-matching-user",
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      }),
    ).toBe(true);
  });
});

describe("getAllFeatureStates", () => {
  it("should return states for all feature switches", () => {
    const states = getAllFeatureStates();
    // Globally enabled switches should be true
    expect(states[FeatureSwitchKey.Dummy]).toBe(true);
    expect(states[FeatureSwitchKey.Pricing]).toBe(true);
  });

  it("should enable switches when orgId matches enabledOrgIdHashes", () => {
    const states = getAllFeatureStates({
      orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    });
    // Switches with STAFF_ORG_ID_HASHES should be true
    expect(states[FeatureSwitchKey.AhrefsConnector]).toBe(true);
    // Globally enabled should still be true
    expect(states[FeatureSwitchKey.Dummy]).toBe(true);
    // Switches without org hashes should remain false
    expect(states[FeatureSwitchKey.Secrets]).toBe(false);
  });

  it("should return false for switches with orgId hashes when orgId does not match", () => {
    const states = getAllFeatureStates({
      orgId: "org_nonexistent",
    });
    expect(states[FeatureSwitchKey.AhrefsConnector]).toBe(false);
  });
});
