import { describe, expect, it } from "vitest";
import { testContext } from "./test-helpers";
import { setupPage } from "../../__tests__/helper";

const context = testContext();
describe("global method", () => {
  it("should has vm0 method after init", async () => {
    await setupPage({ context, path: "/" });

    expect(window._vm0).toBeDefined();
  });
});
