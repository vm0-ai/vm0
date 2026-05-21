import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { seedUserFeatureSwitches } from "../../../../src/__tests__/db-test-seeders/feature-switches";
import { loadDocsFeatureSwitchOverrides } from "../feature-switch-overrides";

const context = testContext();

describe("loadDocsFeatureSwitchOverrides", () => {
  it("returns undefined when no overrides exist", async () => {
    context.setupMocks();
    const { orgId, userId } = await context.setupUser();

    const result = await loadDocsFeatureSwitchOverrides(orgId, userId);

    expect(result).toBeUndefined();
  });

  it("returns stored docs feature switch overrides", async () => {
    context.setupMocks();
    const { orgId, userId } = await context.setupUser();

    await seedUserFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.DocsSite]: true,
    });

    const result = await loadDocsFeatureSwitchOverrides(orgId, userId);

    expect(result).toEqual({
      [FeatureSwitchKey.DocsSite]: true,
    });
  });
});
