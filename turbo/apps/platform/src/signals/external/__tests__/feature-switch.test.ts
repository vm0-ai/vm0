import { describe, expect, it } from "vitest";
import { testContext } from "../../__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import { featureSwitch$ } from "../feature-switch";
import { mockUser } from "../../../__tests__/mock-auth";

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
    mockUser(
      { id: "test-user-123", fullName: "Test User" },
      { token: "test-token" },
    );
    // Set unsafeMetadata on the mocked user before setupPage
    // We need to call mockUser first, then set unsafeMetadata
    await setupPage({ context, path: "/", withoutRender: true });

    // Dummy is globally enabled (true). Override it to false via unsafeMetadata.
    // Access the mocked clerk user and set unsafeMetadata
    const clerk = await context.store.get((await import("../../auth")).clerk$);
    if (clerk.user) {
      (
        clerk.user as unknown as { unsafeMetadata: Record<string, unknown> }
      ).unsafeMetadata = {
        featureSwitches: { dummy: false },
      };
    }

    // Force re-evaluation
    const { overrideFeatureSwitch$ } = await import("../feature-switch");
    context.store.set(overrideFeatureSwitch$, {});

    const result = await context.store.get(featureSwitch$);
    expect(result.dummy).toBeFalsy();
  });

  it("should prioritize localStorage over Clerk unsafeMetadata", async () => {
    mockUser(
      { id: "test-user-123", fullName: "Test User" },
      { token: "test-token" },
    );
    await setupPage({
      context,
      path: "/",
      featureSwitches: { dummy: true },
      withoutRender: true,
    });

    // Set Clerk unsafeMetadata to false
    const clerk = await context.store.get((await import("../../auth")).clerk$);
    if (clerk.user) {
      (
        clerk.user as unknown as { unsafeMetadata: Record<string, unknown> }
      ).unsafeMetadata = {
        featureSwitches: { dummy: false },
      };
    }

    // Force re-evaluation
    const { overrideFeatureSwitch$ } = await import("../feature-switch");
    context.store.set(overrideFeatureSwitch$, {});

    // localStorage says true, Clerk says false — localStorage wins
    const result = await context.store.get(featureSwitch$);
    expect(result.dummy).toBeTruthy();
  });
});
