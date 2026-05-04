import { describe, expect, it, vi } from "vitest";
import { toast } from "@vm0/ui/components/ui/sonner";
import { testContext } from "../../__tests__/test-helpers";
import { detachedSetupPage, setupPage } from "../../../__tests__/page-helper";
import {
  featureSwitch$,
  reloadFeatureSwitch$,
  setFeatureSwitch$,
  resetFeatureSwitches$,
} from "../feature-switch";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers";
import { server } from "../../../mocks/server";
import { createMockApi } from "../../../mocks/msw-contract";

vi.mock("@vm0/ui/components/ui/sonner", () => {
  return { toast: { error: vi.fn(), success: vi.fn() } };
});

const context = testContext();
const mockApi = createMockApi(context);

describe("feature switch", () => {
  it("should support dummy switch", () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    expect(context.store.get(featureSwitch$)).toHaveProperty("dummy", true);
  });

  it("should override dummy switch via the server record", () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dummy: false },
      withoutRender: true,
    });

    expect(context.store.get(featureSwitch$)).toHaveProperty("dummy", false);
  });

  it("should not override keys not present in the server record", () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: {},
      withoutRender: true,
    });

    expect(context.store.get(featureSwitch$)).toHaveProperty("dummy", true);
  });

  it("should apply DB API overrides", () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.Dummy]: false },
      withoutRender: true,
    });

    const result = context.store.get(featureSwitch$);
    expect(result.dummy).toBeFalsy();
  });

  it("should write a single switch via setFeatureSwitch$", async () => {
    await setupPage({ context, path: "/", withoutRender: true });
    expect(context.store.get(featureSwitch$).dummy).toBeTruthy();

    // Mimic server-side persistence: subsequent GETs return the new state.
    setMockFeatureSwitches({ [FeatureSwitchKey.Dummy]: false });

    await context.store.set(
      setFeatureSwitch$,
      { [FeatureSwitchKey.Dummy]: false },
      context.signal,
    );

    expect(context.store.get(featureSwitch$).dummy).toBeFalsy();
  });

  it("should reset all switches by deleting the server row", async () => {
    await setupPage({
      context,
      path: "/",
      featureSwitches: { dummy: false },
      withoutRender: true,
    });
    expect(context.store.get(featureSwitch$).dummy).toBeFalsy();

    // Mimic server-side reset: subsequent GETs return empty switches.
    setMockFeatureSwitches({});

    await context.store.set(resetFeatureSwitches$, context.signal);

    expect(context.store.get(featureSwitch$).dummy).toBeTruthy();
  });

  it("should toast on DB sync failure", async () => {
    server.use(
      mockApi(zeroFeatureSwitchesContract.update, ({ respond }) => {
        return respond(500, {
          error: { message: "Server error", code: "INTERNAL" },
        });
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    await expect(
      context.store.set(
        setFeatureSwitch$,
        { [FeatureSwitchKey.Dummy]: false },
        context.signal,
      ),
    ).rejects.toThrow("Server error");

    expect(toast.error).toHaveBeenCalledWith("Server error");
  });

  it("reloadFeatureSwitch$ refreshes stale cache from server", async () => {
    // Cold start: cache holds dummy=false (e.g. from a previous session).
    await setupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.Dummy]: false },
      withoutRender: true,
    });
    expect(context.store.get(featureSwitch$).dummy).toBeFalsy();

    // Server flips dummy back on after the cache was written.
    setMockFeatureSwitches({ [FeatureSwitchKey.Dummy]: true });

    await context.store.set(reloadFeatureSwitch$, context.signal);

    expect(context.store.get(featureSwitch$).dummy).toBeTruthy();
  });

  it("should propagate abort without toasting", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const abortedSignal = AbortSignal.abort(new Error("test abort"));

    await expect(
      context.store.set(
        setFeatureSwitch$,
        { [FeatureSwitchKey.Dummy]: false },
        abortedSignal,
      ),
    ).rejects.toThrow();

    expect(toast.error).not.toHaveBeenCalled();
  });
});
