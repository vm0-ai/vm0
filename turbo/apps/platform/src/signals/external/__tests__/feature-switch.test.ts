import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@vm0/ui/components/ui/sonner";
import { testContext } from "../../__tests__/test-helpers";
import { detachedSetupPage } from "../../../__tests__/page-helper";
import {
  featureSwitch$,
  setFeatureSwitch$,
  resetFeatureSwitches$,
} from "../feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { zeroFeatureSwitchesContract } from "@vm0/core/contracts/zero-feature-switches";
import {
  getMockFeatureSwitches,
  setMockFeatureSwitches,
} from "../../../mocks/handlers/api-feature-switches";
import { server } from "../../../mocks/server";
import { createMockApi } from "../../../mocks/msw-contract";

vi.mock("@vm0/ui/components/ui/sonner", () => {
  return { toast: { error: vi.fn(), success: vi.fn() } };
});

beforeEach(() => {
  vi.clearAllMocks();
});

const context = testContext();
const mockApi = createMockApi(context);

describe("feature switch", () => {
  it("should support dummy switch", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    await expect(context.store.get(featureSwitch$)).resolves.toHaveProperty(
      "dummy",
      true,
    );
  });

  it("should override dummy switch via the server record", async () => {
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

  it("should not override keys not present in the server record", async () => {
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
    setMockFeatureSwitches({ [FeatureSwitchKey.Dummy]: false });
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const result = await context.store.get(featureSwitch$);
    expect(result.dummy).toBeFalsy();
  });

  it("should write a single switch via setFeatureSwitch$", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(
      setFeatureSwitch$,
      { [FeatureSwitchKey.Dummy]: false },
      context.signal,
    );

    const result = await context.store.get(featureSwitch$);
    expect(result.dummy).toBeFalsy();
    expect(getMockFeatureSwitches()).toMatchObject({ dummy: false });
  });

  it("should reset all switches by deleting the server row", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dummy: false },
      withoutRender: true,
    });

    const before = await context.store.get(featureSwitch$);
    expect(before.dummy).toBeFalsy();

    await context.store.set(resetFeatureSwitches$, context.signal);

    const after = await context.store.get(featureSwitch$);
    expect(after.dummy).toBeTruthy();
    expect(getMockFeatureSwitches()).toStrictEqual({});
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
