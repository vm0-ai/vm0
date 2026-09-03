import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "../feature-switch-key";
import {
  isFeatureEnabled,
  getAllFeatureStates,
  filterFeatureSwitchOverrides,
  getFeatureSwitchDescriptions,
  getFeatureSwitchMetadata,
} from "../feature-switch";

describe("FeatureSwitchKey", () => {
  it("uses the canonical internal switch names", () => {
    expect(FeatureSwitchKey.PersonalModelProviderAccounts).toBe(
      "_multipleSubscriptions",
    );
    expect(FeatureSwitchKey.Dummy).toBe("_dummy");
    expect(FeatureSwitchKey.Lab).toBe("_lab");
    expect(FeatureSwitchKey.SidebarSubscriptionUsage).toBe(
      "_sidebarSubscriptionUsage",
    );
    expect(FeatureSwitchKey.FeishuIntegration).toBe("_feishuIntegration");
    expect(FeatureSwitchKey.CodexFastMode).toBe("_fastModel");
    expect(FeatureSwitchKey.OkouDebug).toBe("_debug");
    expect(FeatureSwitchKey.RealAgentInPreview).toBe("_realAgentInPreview");
    expect(FeatureSwitchKey.TestOauthConnector).toBe("_testOauthConnector");
    expect(FeatureSwitchKey.ChatRunWorkFolding).toBe("chatRunWorkFolding");
  });
});

describe("isFeatureEnabled", () => {
  it("should return true for globally enabled switch", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Dummy, {})).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.NotionWorkflowAutomations, {}),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.GoogleFormsWorkflowAutomations, {}),
    ).toBe(true);
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

  it("should apply user overrides to the staff-default Official Workflows switch", () => {
    const staffOrgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
    expect(
      isFeatureEnabled(FeatureSwitchKey.OfficialWorkflows, {
        orgId: staffOrgId,
      }),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.OfficialWorkflows, {
        orgId: staffOrgId,
        overrides: { [FeatureSwitchKey.OfficialWorkflows]: false },
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.OfficialWorkflows, {
        orgId: "org_nonexistent",
        overrides: { [FeatureSwitchKey.OfficialWorkflows]: true },
      }),
    ).toBe(true);
  });

  it("should release Morning Brief independently from Official Workflows and preserve false overrides", () => {
    const ordinaryOrgId = "org_nonexistent";
    expect(FeatureSwitchKey.MorningBrief).toBe("morningBrief");
    expect(isFeatureEnabled(FeatureSwitchKey.MorningBrief, {})).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.MorningBrief, {
        orgId: ordinaryOrgId,
      }),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.MorningBrief, {
        orgId: ordinaryOrgId,
        overrides: { [FeatureSwitchKey.MorningBrief]: false },
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.OfficialWorkflows, {
        orgId: ordinaryOrgId,
      }),
    ).toBe(false);
    expect(getFeatureSwitchMetadata()[FeatureSwitchKey.MorningBrief]).toEqual({
      maintainer: "lancy@vm0.ai",
      description:
        "Enable the first-class Morning Brief experience in Preferences.",
      rolloutStage: "released",
    });
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
    expect(staffOrgStates[FeatureSwitchKey.ChatErrorRecovery]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.BatchChatEventCatchUp]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.ChatRunWorkFolding]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.PiLoop]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.PiMemoryRecall]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.PiMemoryGeneration]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.NewChatDefaultModelAction]).toBe(
      true,
    );
    expect(staffOrgStates[FeatureSwitchKey.CustomConnectorMcp]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.PersonalModelProviderAccounts]).toBe(
      true,
    );
    expect(staffOrgStates[FeatureSwitchKey.ConnectorAccounts]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.PresentationTemplates]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.ChatTranslation]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.FollowUpOptimize]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.VoiceDraft]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.IntroVideo]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.DesktopScreenRecording]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.GradientColorThemes]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.OfficialWorkflows]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.MorningBrief]).toBe(true);

    const otherOrgStates = getAllFeatureStates({
      orgId: "org_nonexistent",
    });
    expect(otherOrgStates[FeatureSwitchKey.Lab]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.ChatErrorRecovery]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.BatchChatEventCatchUp]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.ChatRunWorkFolding]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PiLoop]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PiMemoryRecall]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PiMemoryGeneration]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.NewChatDefaultModelAction]).toBe(
      false,
    );
    expect(otherOrgStates[FeatureSwitchKey.CustomConnectorMcp]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PersonalModelProviderAccounts]).toBe(
      false,
    );
    expect(otherOrgStates[FeatureSwitchKey.ConnectorAccounts]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PresentationTemplates]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.ChatTranslation]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.FollowUpOptimize]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.VoiceDraft]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.IntroVideo]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.DesktopScreenRecording]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.GradientColorThemes]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.OfficialWorkflows]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.MorningBrief]).toBe(true);
  });

  it("should enable intro video and desktop recording for staff", () => {
    const staffStates = getAllFeatureStates({
      email: "ethan@vm0.ai",
      orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    });
    expect(staffStates[FeatureSwitchKey.IntroVideo]).toBe(true);
    expect(staffStates[FeatureSwitchKey.DesktopScreenRecording]).toBe(true);
  });

  it("should enable gradient color themes for Ming only", () => {
    const mingStates = getAllFeatureStates({
      email: "MING@VM0.AI",
      orgId: "org_nonexistent",
    });
    expect(mingStates[FeatureSwitchKey.GradientColorThemes]).toBe(true);

    const otherStaffStates = getAllFeatureStates({
      email: "ethan@vm0.ai",
      orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    });
    expect(otherStaffStates[FeatureSwitchKey.GradientColorThemes]).toBe(false);
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

describe("feature switch override filtering", () => {
  it("keeps overrides for every registered switch", () => {
    const switches = Object.fromEntries(
      Object.values(FeatureSwitchKey).map((key) => {
        return [key, true];
      }),
    );

    expect(filterFeatureSwitchOverrides(switches)).toStrictEqual(switches);
  });

  it("ignores persisted overrides for removed switches", () => {
    expect(
      filterFeatureSwitchOverrides({
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
      expect(metadata[key]?.rolloutStage).toMatch(
        /^(released|beta|alpha|internal)$/u,
      );
    }
  });

  it("should classify only underscore-prefixed switches as internal", () => {
    const metadata = getFeatureSwitchMetadata();

    for (const key of Object.values(FeatureSwitchKey)) {
      if (key.startsWith("_")) {
        expect(metadata[key].rolloutStage).toBe("internal");
      } else {
        expect(metadata[key].rolloutStage).not.toBe("internal");
      }
    }
  });

  it("should classify non-internal switches by rollout audience", () => {
    const metadata = getFeatureSwitchMetadata();

    expect(
      metadata[FeatureSwitchKey.NotionWorkflowAutomations].rolloutStage,
    ).toBe("released");
    expect(metadata[FeatureSwitchKey.Banking].rolloutStage).toBe("beta");
    expect(metadata[FeatureSwitchKey.IntroVideo].rolloutStage).toBe("beta");
    expect(metadata[FeatureSwitchKey.DesktopScreenRecording].rolloutStage).toBe(
      "beta",
    );
    expect(metadata[FeatureSwitchKey.AhrefsConnector].rolloutStage).toBe(
      "alpha",
    );
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
