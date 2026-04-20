import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@vm0/ui/components/ui/sonner";
import { testContext } from "../../__tests__/test-helpers";
import { detachedSetupPage } from "../../../__tests__/page-helper";
import {
  featureSwitch$,
  syncFeatureSwitchToDB$,
  resetFeatureSwitchOverrides$,
  getFeatureSwitchLocalStorage$,
} from "../feature-switch";
import { FeatureSwitchKey, zeroFeatureSwitchesContract } from "@vm0/core";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches";
import { server } from "../../../mocks/server";
import { mockApi } from "../../../mocks/msw-contract";

vi.mock("@vm0/ui/components/ui/sonner", () => {
  return { toast: { error: vi.fn(), success: vi.fn() } };
});

beforeEach(() => {
  vi.clearAllMocks();
});

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

  it("should clear localStorage key after successful DB sync", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dummy: false },
      withoutRender: true,
    });

    // Sanity: localStorage holds the optimistic override
    expect(context.store.get(getFeatureSwitchLocalStorage$)).toContain("dummy");

    await context.store.set(
      syncFeatureSwitchToDB$,
      { [FeatureSwitchKey.Dummy]: false },
      context.signal,
    );

    // localStorage is cleaned up; DB is now source of truth
    expect(context.store.get(getFeatureSwitchLocalStorage$)).toBeNull();
    const result = await context.store.get(featureSwitch$);
    expect(result.dummy).toBeFalsy();
  });

  it("should strip synced key and preserve other in-flight overrides", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: {
        [FeatureSwitchKey.Dummy]: false,
        [FeatureSwitchKey.VoiceChat]: true,
      },
      withoutRender: true,
    });

    await context.store.set(
      syncFeatureSwitchToDB$,
      { [FeatureSwitchKey.Dummy]: false },
      context.signal,
    );

    const stored = context.store.get(getFeatureSwitchLocalStorage$);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored ?? "{}") as Record<string, boolean>;
    expect(parsed).not.toHaveProperty(FeatureSwitchKey.Dummy);
    expect(parsed).toHaveProperty(FeatureSwitchKey.VoiceChat, true);
  });

  it("should strip localStorage and toast on DB sync failure", async () => {
    server.use(
      mockApi(zeroFeatureSwitchesContract.update, ({ respond }) => {
        return respond(500, {
          error: { message: "Server error", code: "INTERNAL" },
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dummy: false },
      withoutRender: true,
    });

    await expect(
      context.store.set(
        syncFeatureSwitchToDB$,
        { [FeatureSwitchKey.Dummy]: false },
        context.signal,
      ),
    ).rejects.toThrow("Server error");

    expect(toast.error).toHaveBeenCalledWith("Server error");
    expect(context.store.get(getFeatureSwitchLocalStorage$)).toBeNull();
  });

  it("should strip localStorage on abort without toasting", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dummy: false },
      withoutRender: true,
    });

    const abortedSignal = AbortSignal.abort(new Error("test abort"));

    await expect(
      context.store.set(
        syncFeatureSwitchToDB$,
        { [FeatureSwitchKey.Dummy]: false },
        abortedSignal,
      ),
    ).rejects.toThrow();

    expect(toast.error).not.toHaveBeenCalled();
    expect(context.store.get(getFeatureSwitchLocalStorage$)).toBeNull();
  });
});
