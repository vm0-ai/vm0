import { describe, expect, it } from "vitest";
import { testContext } from "../../__tests__/test-helpers";
import { detachedSetupPage } from "../../../__tests__/page-helper";
import {
  featureSwitch$,
  syncFeatureSwitchToDB$,
  resetFeatureSwitchOverrides$,
} from "../feature-switch";
import { FeatureSwitchKey } from "@vm0/core";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches";

const context = testContext();

describe("feature switch", () => {
  it("should support dummy switch", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    await expect(context.store.get(featureSwitch$)).resolves.toHaveProperty(
      "dummy",
      true,
    );
  });

  it("should override dummy switch", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dummy: false },
      withoutRender: true,
    });

    await expect(context.store.get(featureSwitch$)).resolves.toHaveProperty(
      "dummy",
      false,
    );
  });

  it("should not override keys not present in localStorage", async () => {
    // When localStorage only has partial overrides, other keys should keep their default values
    // Setting an empty object should not affect the default value of 'dummy' (which is true)
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: {},
      withoutRender: true,
    });

    await expect(context.store.get(featureSwitch$)).resolves.toHaveProperty(
      "dummy",
      true,
    );
  });

  it("should apply DB API overrides", async () => {
    // Dummy is globally enabled (true). Override it to false via DB API.
    setMockFeatureSwitches({ [FeatureSwitchKey.Dummy]: false });
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const result = await context.store.get(featureSwitch$);
    expect(result.dummy).toBeFalsy();
  });

  it("should prioritize localStorage over DB API overrides", async () => {
    // localStorage says dummy=true, DB says dummy=false — localStorage wins
    setMockFeatureSwitches({ [FeatureSwitchKey.Dummy]: false });
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dummy: true },
      withoutRender: true,
    });

    const result = await context.store.get(featureSwitch$);
    expect(result.dummy).toBeTruthy();
  });

  it("should sync feature switch override to DB API", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(
      syncFeatureSwitchToDB$,
      { [FeatureSwitchKey.Dummy]: false },
      context.signal,
    );

    // After syncing, the DB layer should reflect the override
    const result = await context.store.get(featureSwitch$);
    expect(result.dummy).toBeFalsy();
  });

  it("should reset localStorage overrides", async () => {
    // Set localStorage override, then reset
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dummy: false },
      withoutRender: true,
    });

    // Confirm override is active
    const before = await context.store.get(featureSwitch$);
    expect(before.dummy).toBeFalsy();

    // Reset overrides — dummy should return to its default (true)
    await context.store.set(resetFeatureSwitchOverrides$, context.signal);

    const after = await context.store.get(featureSwitch$);
    expect(after.dummy).toBeTruthy();
  });
});
