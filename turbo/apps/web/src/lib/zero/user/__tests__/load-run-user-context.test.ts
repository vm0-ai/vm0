import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../../../__tests__/test-helpers";
import { seedUserFeatureSwitches } from "../../../../__tests__/db-test-seeders/feature-switches";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { loadRunUserContext } from "../user-context-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { updateUserPreferences } from "../user-preferences-service";

const context = testContext();

describe("loadRunUserContext", () => {
  it("returns both when prefs and feature-switch rows are present", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    await updateUserPreferences(orgId, userId, {
      timezone: "Asia/Shanghai",
      captureNetworkBodiesRemaining: 5,
    });
    await seedUserFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.ComputerUse]: true,
    });

    const result = await loadRunUserContext(orgId, userId);

    expect(result).toEqual({
      timezone: "Asia/Shanghai",
      overrides: { [FeatureSwitchKey.ComputerUse]: true },
      captureNetworkBodiesRemaining: 5,
    });
  });

  it("returns null timezone and zero capture quota when prefs row missing", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    await seedUserFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.ComputerUse]: true,
    });

    const result = await loadRunUserContext(orgId, userId);

    expect(result).toEqual({
      timezone: null,
      overrides: { [FeatureSwitchKey.ComputerUse]: true },
      captureNetworkBodiesRemaining: 0,
    });
  });

  it("returns undefined overrides when feature-switch row missing (majority case)", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    await updateUserPreferences(orgId, userId, { timezone: "UTC" });

    const result = await loadRunUserContext(orgId, userId);

    expect(result).toEqual({
      timezone: "UTC",
      overrides: undefined,
      captureNetworkBodiesRemaining: 0,
    });
  });

  it("returns defaults when both rows missing", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    const result = await loadRunUserContext(orgId, userId);

    expect(result).toEqual({
      timezone: null,
      overrides: undefined,
      captureNetworkBodiesRemaining: 0,
    });
  });

  it("surfaces non-zero captureNetworkBodiesRemaining from prefs row", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    await updateUserPreferences(orgId, userId, {
      captureNetworkBodiesRemaining: 3,
    });

    const result = await loadRunUserContext(orgId, userId);

    expect(result.captureNetworkBodiesRemaining).toBe(3);
  });
});
