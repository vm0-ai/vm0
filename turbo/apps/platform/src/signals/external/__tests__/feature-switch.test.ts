import { describe, expect, it } from "vitest";
import { testContext } from "../../__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import {
  featureSwitch$,
  syncFeatureSwitchToClerk$,
  resetFeatureSwitchOverrides$,
} from "../feature-switch";
import { FeatureSwitchKey } from "@vm0/core";

const context = testContext();

describe("feature switch", () => {
  it("should support dummy switch", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    await expect(context.store.get(featureSwitch$)).resolves.toHaveProperty(
      "dummy",
      true,
    );
  });

  it("should override dummy switch", async () => {
    await setupPage({
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
    await setupPage({
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

  it("should apply Clerk unsafeMetadata overrides", async () => {
    // Dummy is globally enabled (true). Override it to false via Clerk unsafeMetadata.
    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(
      syncFeatureSwitchToClerk$,
      { [FeatureSwitchKey.Dummy]: false },
      context.signal,
    );

    const result = await context.store.get(featureSwitch$);
    expect(result.dummy).toBeFalsy();
  });

  it("should prioritize localStorage over Clerk unsafeMetadata", async () => {
    // localStorage says dummy=true, Clerk says dummy=false — localStorage wins
    await setupPage({
      context,
      path: "/",
      featureSwitches: { dummy: true },
      withoutRender: true,
    });

    await context.store.set(
      syncFeatureSwitchToClerk$,
      { [FeatureSwitchKey.Dummy]: false },
      context.signal,
    );

    const result = await context.store.get(featureSwitch$);
    expect(result.dummy).toBeTruthy();
  });

  it("should sync feature switch override to Clerk unsafeMetadata", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(
      syncFeatureSwitchToClerk$,
      { [FeatureSwitchKey.Dummy]: false },
      context.signal,
    );

    // After syncing, the Clerk layer should reflect the override
    const result = await context.store.get(featureSwitch$);
    expect(result.dummy).toBeFalsy();
  });

  it("should reset all feature switch overrides", async () => {
    // Set localStorage and Clerk overrides, then reset both
    await setupPage({
      context,
      path: "/",
      featureSwitches: { dummy: false },
      withoutRender: true,
    });

    await context.store.set(
      syncFeatureSwitchToClerk$,
      { [FeatureSwitchKey.Dummy]: false },
      context.signal,
    );

    // Confirm override is active
    const before = await context.store.get(featureSwitch$);
    expect(before.dummy).toBeFalsy();

    // Reset all overrides — dummy should return to its default (true)
    await context.store.set(resetFeatureSwitchOverrides$, context.signal);

    const after = await context.store.get(featureSwitch$);
    expect(after.dummy).toBeTruthy();
  });
});
