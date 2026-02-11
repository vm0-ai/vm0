import { describe, expect, it } from "vitest";
import { testContext } from "../../__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import { featureSwitch$ } from "../feature-switch";

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
});
