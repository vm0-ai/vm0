import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "@vm0/core";
import { testContext } from "../../../../__tests__/test-helpers";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import {
  loadFeatureSwitchOverrides,
  updateUserFeatureSwitches,
} from "../feature-switches-service";

const context = testContext();

describe("loadFeatureSwitchOverrides", () => {
  it("should return undefined when orgId is undefined", async () => {
    context.setupMocks();
    const { userId } = await context.setupUser();

    const result = await loadFeatureSwitchOverrides(undefined, userId);

    expect(result).toBeUndefined();
  });

  it("should return undefined when userId is undefined", async () => {
    context.setupMocks();
    const { orgId } = await context.setupUser();

    const result = await loadFeatureSwitchOverrides(orgId, undefined);

    expect(result).toBeUndefined();
  });

  it("should return undefined when no overrides exist in DB", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    const result = await loadFeatureSwitchOverrides(orgId, userId);

    expect(result).toBeUndefined();
  });

  it("should return overrides when they exist in DB", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    await updateUserFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.VoiceChat]: false,
      [FeatureSwitchKey.ComputerUse]: true,
    });

    const result = await loadFeatureSwitchOverrides(orgId, userId);

    expect(result).toEqual({
      [FeatureSwitchKey.VoiceChat]: false,
      [FeatureSwitchKey.ComputerUse]: true,
    });
  });

  it("should return undefined when both orgId and userId are undefined", async () => {
    context.setupMocks();

    const result = await loadFeatureSwitchOverrides(undefined, undefined);

    expect(result).toBeUndefined();
  });
});
