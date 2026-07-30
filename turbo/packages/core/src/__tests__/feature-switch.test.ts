import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "../feature-switch-key";
import {
  isFeatureEnabled,
  getAllFeatureStates,
  filterUserOverridableFeatureSwitchOverrides,
  getFeatureSwitchDescriptions,
  getFeatureSwitchMetadata,
  getUserOverridableFeatureSwitchKeys,
} from "../feature-switch";

describe("isFeatureEnabled", () => {
  it("should return true for globally enabled switch", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Dummy, {})).toBe(true);
    expect(isFeatureEnabled(FeatureSwitchKey.ImageStyleR2, {})).toBe(true);
    expect(isFeatureEnabled(FeatureSwitchKey.VideoArtifactPosters, {})).toBe(
      true,
    );
    expect(isFeatureEnabled(FeatureSwitchKey.LanguagePreference, {})).toBe(
      true,
    );
  });

  it("should return true for globally enabled switch even with context", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Dummy, { userId: "any-user" }),
    ).toBe(true);
  });

  it("should return false for disabled switch without context", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {})).toBe(false);
    expect(isFeatureEnabled(FeatureSwitchKey.MetaAdsConnector, {})).toBe(false);
    expect(isFeatureEnabled(FeatureSwitchKey.GoogleContactsConnector, {})).toBe(
      false,
    );
    expect(isFeatureEnabled(FeatureSwitchKey.GoogleFormsConnector, {})).toBe(
      false,
    );
    expect(isFeatureEnabled(FeatureSwitchKey.JoggAiConnector, {})).toBe(false);
    expect(isFeatureEnabled(FeatureSwitchKey.Artifacts, {})).toBe(false);
    expect(isFeatureEnabled(FeatureSwitchKey.ComposerUploadPopover, {})).toBe(
      false,
    );
    expect(
      isFeatureEnabled(FeatureSwitchKey.StructuredPromptInlineTemplates, {}),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.ChatThreadSidebarAutoOpen, {}),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.BrazilianPortugueseLocale, {}),
    ).toBe(false);
    expect(isFeatureEnabled(FeatureSwitchKey.KoreanLocale, {})).toBe(false);
    expect(isFeatureEnabled(FeatureSwitchKey.ZeroChatMessaging, {})).toBe(
      false,
    );
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
  });

  it("should return false when orgId does not match enabledOrgIdHashes", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Lab, {
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
    expect(staffOrgStates[FeatureSwitchKey.ZeroBrowser]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.ZeroChatMessaging]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.LanguagePreference]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.BrazilianPortugueseLocale]).toBe(
      false,
    );
    expect(staffOrgStates[FeatureSwitchKey.KoreanLocale]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.ClaudeSessionPruning]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.ChatThreadUnifiedSearch]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.ChatThreadSidebarAutoOpen]).toBe(
      true,
    );
    expect(staffOrgStates[FeatureSwitchKey.ComposerSkillSubstringSearch]).toBe(
      true,
    );
    expect(staffOrgStates[FeatureSwitchKey.Artifacts]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.HostedArtifactVersions]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.ImageStyleR2]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.ComposerUploadPopover]).toBe(false);
    expect(
      staffOrgStates[FeatureSwitchKey.StructuredPromptInlineTemplates],
    ).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.WorkflowConnectorReadiness]).toBe(
      true,
    );
    expect(staffOrgStates[FeatureSwitchKey.GithubWebhookAutomations]).toBe(
      true,
    );
    expect(staffOrgStates[FeatureSwitchKey.StrapiIntegration]).toBe(true);

    const otherOrgStates = getAllFeatureStates({
      orgId: "org_nonexistent",
    });
    expect(otherOrgStates[FeatureSwitchKey.Lab]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.ZeroBrowser]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.ZeroChatMessaging]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.LanguagePreference]).toBe(true);
    expect(otherOrgStates[FeatureSwitchKey.BrazilianPortugueseLocale]).toBe(
      false,
    );
    expect(otherOrgStates[FeatureSwitchKey.KoreanLocale]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.ClaudeSessionPruning]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.ChatThreadUnifiedSearch]).toBe(
      false,
    );
    expect(otherOrgStates[FeatureSwitchKey.ChatThreadSidebarAutoOpen]).toBe(
      false,
    );
    expect(otherOrgStates[FeatureSwitchKey.ComposerSkillSubstringSearch]).toBe(
      false,
    );
    expect(otherOrgStates[FeatureSwitchKey.Artifacts]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.ImageStyleR2]).toBe(true);
    expect(otherOrgStates[FeatureSwitchKey.ComposerUploadPopover]).toBe(false);
    expect(
      otherOrgStates[FeatureSwitchKey.StructuredPromptInlineTemplates],
    ).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.WorkflowConnectorReadiness]).toBe(
      false,
    );
    expect(otherOrgStates[FeatureSwitchKey.GithubWebhookAutomations]).toBe(
      false,
    );
    expect(otherOrgStates[FeatureSwitchKey.StrapiIntegration]).toBe(false);
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

describe("user-overridable switches", () => {
  it("excludes internal switches from user override helpers", () => {
    expect(getUserOverridableFeatureSwitchKeys()).not.toContain(
      FeatureSwitchKey.ComposerUploadPopover,
    );
    expect(getUserOverridableFeatureSwitchKeys()).not.toContain(
      FeatureSwitchKey.WorkflowConnectorReadiness,
    );
    expect(getUserOverridableFeatureSwitchKeys()).not.toContain(
      FeatureSwitchKey.ZeroMailReplyFollowUp,
    );
    expect(getUserOverridableFeatureSwitchKeys()).toContain(
      FeatureSwitchKey.LanguagePreference,
    );
    expect(getUserOverridableFeatureSwitchKeys()).not.toContain(
      FeatureSwitchKey.BrazilianPortugueseLocale,
    );
    expect(getUserOverridableFeatureSwitchKeys()).not.toContain(
      FeatureSwitchKey.KoreanLocale,
    );
    expect(getUserOverridableFeatureSwitchKeys()).toContain(
      FeatureSwitchKey.ZeroBrowser,
    );
    expect(getUserOverridableFeatureSwitchKeys()).not.toContain(
      FeatureSwitchKey.GithubWebhookAutomations,
    );
    expect(getUserOverridableFeatureSwitchKeys()).not.toContain(
      FeatureSwitchKey.StrapiIntegration,
    );
    expect(getUserOverridableFeatureSwitchKeys()).toContain(
      FeatureSwitchKey.StructuredPromptInlineTemplates,
    );
    expect(getUserOverridableFeatureSwitchKeys()).toContain(
      FeatureSwitchKey.ComposerConnectorPermissions,
    );
    expect(getUserOverridableFeatureSwitchKeys()).toContain(
      FeatureSwitchKey.ImageStyleR2,
    );

    expect(
      filterUserOverridableFeatureSwitchOverrides({
        [FeatureSwitchKey.ComposerUploadPopover]: true,
        [FeatureSwitchKey.WorkflowConnectorReadiness]: true,
        [FeatureSwitchKey.StructuredPromptInlineTemplates]: true,
        [FeatureSwitchKey.ZeroMailReplyFollowUp]: true,
        [FeatureSwitchKey.BrazilianPortugueseLocale]: true,
        [FeatureSwitchKey.KoreanLocale]: true,
        [FeatureSwitchKey.ZeroBrowser]: true,
        [FeatureSwitchKey.ComposerConnectorPermissions]: true,
        [FeatureSwitchKey.Dummy]: false,
      }),
    ).toStrictEqual({
      [FeatureSwitchKey.ZeroBrowser]: true,
      [FeatureSwitchKey.ComposerConnectorPermissions]: true,
      [FeatureSwitchKey.Dummy]: false,
      [FeatureSwitchKey.StructuredPromptInlineTemplates]: true,
    });
  });

  it("ignores persisted overrides for removed switches", () => {
    expect(
      filterUserOverridableFeatureSwitchOverrides({
        zeroPeopleSearch: false,
      }),
    ).toStrictEqual({});
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

describe("getFeatureSwitchMetadata", () => {
  it("should return display metadata for every switch", () => {
    const metadata = getFeatureSwitchMetadata();
    for (const key of Object.values(FeatureSwitchKey)) {
      expect(metadata[key]?.maintainer).toEqual(expect.any(String));
      expect(metadata[key]?.description).toEqual(expect.any(String));
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
