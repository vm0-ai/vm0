import { describe, expect, it } from "vitest";
import { testContext } from "../../__tests__/test-helpers";
import { setupPage } from "../../../__tests__/helper";
import { modelProviders$ } from "../model-providers";

const context = testContext();
describe("test model providers", () => {
  it("should get correct result from msw", async () => {
    await setupPage({
      context,
      path: "/",
    });

    await expect(context.store.get(modelProviders$)).resolves.toHaveProperty(
      "modelProviders",
      [expect.objectContaining({ id: "dummy-provider" })],
    );
  });
});
