import { describe, expect, it } from "vitest";
import { testContext } from "../../__tests__/test-helpers";
import { setupPage } from "../../../__tests__/helper";
import { featureSwitch$ } from "../feature-switch";

const context = testContext();

describe("feature switch", () => {
  it("should support dummy switch", async () => {
    await setupPage({ context, path: "/" });

    await expect(context.store.get(featureSwitch$)).resolves.toHaveProperty(
      "dummy",
      true,
    );
  });

  it("should override dummy switch", async () => {
    await setupPage({ context, path: "/", featureSwitches: { dummy: false } });

    await expect(context.store.get(featureSwitch$)).resolves.toHaveProperty(
      "dummy",
      false,
    );
  });
});
