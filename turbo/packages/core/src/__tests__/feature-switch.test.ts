import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "../feature-switch-key";
import {
  isFeatureEnabled,
  getAllFeatureStates,
  getFeatureSwitchDescriptions,
} from "../feature-switch";

describe("isFeatureEnabled", () => {
  it("should return true for globally enabled switch", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Dummy, {})).toBe(true);
  });

  it("should return true for globally enabled switch even with context", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Dummy, { userId: "any-user" }),
    ).toBe(true);
  });

  it("should return false for disabled switch without context", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {})).toBe(false);
  });

  it("should return false for disabled switch with non-matching userId", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        userId: "some-user",
      }),
    ).toBe(false);
  });

  it("should return true when orgId hash matches enabledOrgIdHashes", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Lab, {
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      }),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.SkillsViewer, {
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      }),
    ).toBe(true);
  });

  it("should return false when orgId does not match enabledOrgIdHashes", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Lab, {
        orgId: "org_nonexistent",
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.SkillsViewer, {
        orgId: "org_nonexistent",
      }),
    ).toBe(false);
  });

  it("should return false when no orgId provided but switch has enabledOrgIdHashes", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Lab, {})).toBe(false);
  });

  it("should return true when orgId matches even if userId does not", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Lab, {
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
  });

  it("should enable switches when orgId matches enabledOrgIdHashes", () => {
    const states = getAllFeatureStates({
      orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    });
    expect(states[FeatureSwitchKey.Lab]).toBe(true);
    // Globally enabled should still be true
    expect(states[FeatureSwitchKey.Dummy]).toBe(true);
    // Switches without org hashes should remain false
    expect(states[FeatureSwitchKey.AhrefsConnector]).toBe(false);
  });

  it("should return false for switches with orgId hashes when orgId does not match", () => {
    const states = getAllFeatureStates({
      orgId: "org_nonexistent",
    });
    expect(states[FeatureSwitchKey.Lab]).toBe(false);
    expect(states[FeatureSwitchKey.Dummy]).toBe(true);
  });

  it("should reflect the current staff org rollout matrix", () => {
    const staffOrgStates = getAllFeatureStates({
      orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    });
    expect(staffOrgStates[FeatureSwitchKey.Lab]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.SkillsViewer]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.ChatHeaderNewButton]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.ChatThreadRename]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.SessionWorkspaceImageCache]).toBe(
      true,
    );
    expect(staffOrgStates[FeatureSwitchKey.ChatRecommendedFollowups]).toBe(
      true,
    );

    const otherOrgStates = getAllFeatureStates({
      orgId: "org_nonexistent",
    });
    expect(otherOrgStates[FeatureSwitchKey.Lab]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.SkillsViewer]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.SessionWorkspaceImageCache]).toBe(
      false,
    );
    expect(otherOrgStates[FeatureSwitchKey.ChatRecommendedFollowups]).toBe(
      false,
    );
  });

  it("should apply overrides to enable disabled features", () => {
    const states = getAllFeatureStates({
      overrides: { [FeatureSwitchKey.AhrefsConnector]: true },
    });
    expect(states[FeatureSwitchKey.AhrefsConnector]).toBe(true);
    // Non-overridden disabled feature stays false
    expect(states[FeatureSwitchKey.DropboxConnector]).toBe(false);
  });

  it("should apply overrides to disable enabled features", () => {
    const states = getAllFeatureStates({
      overrides: { [FeatureSwitchKey.Dummy]: false },
    });
    expect(states[FeatureSwitchKey.Dummy]).toBe(false);
    // Non-overridden disabled feature stays false
    expect(states[FeatureSwitchKey.AhrefsConnector]).toBe(false);
  });

  it("should ignore override keys that are no longer registered", () => {
    const states = getAllFeatureStates({
      overrides: {
        removedFeature: true,
      } as Partial<Record<FeatureSwitchKey, boolean>>,
    });

    expect("removedFeature" in states).toBe(false);
  });
});

describe("getFeatureSwitchDescriptions", () => {
  it("should return a record with all feature switch keys", () => {
    const descriptions = getFeatureSwitchDescriptions();
    for (const key of Object.values(FeatureSwitchKey)) {
      expect(descriptions).toHaveProperty(key);
    }
  });

  it("should return a description string for every switch", () => {
    const descriptions = getFeatureSwitchDescriptions();
    for (const key of Object.values(FeatureSwitchKey)) {
      expect(descriptions[key]).toEqual(expect.any(String));
    }
  });
});

describe("overrides", () => {
  it("should enable a disabled feature when override is true", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        overrides: { [FeatureSwitchKey.AhrefsConnector]: true },
      }),
    ).toBe(true);
  });

  it("should disable an enabled feature when override is false", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Dummy, {
        overrides: { [FeatureSwitchKey.Dummy]: false },
      }),
    ).toBe(false);
  });

  it("should not affect keys without overrides", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.DropboxConnector, {
        overrides: { [FeatureSwitchKey.AhrefsConnector]: true },
      }),
    ).toBe(false);
  });

  it("should behave identically when no overrides provided", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Dummy, {})).toBe(true);
    expect(isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {})).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.Dummy, { userId: "any-user" }),
    ).toBe(true);
  });
});
