import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { seedVm0ManagedModelKey } from "./helpers/runtime-state";

const context = testContext();

describe("POST /api/test/runtime-state/action", () => {
  it("keeps overlapping VM0 managed model-key fixtures independently releasable", async () => {
    const first = await seedVm0ManagedModelKey(context, "gpt-5.6-terra");
    const second = await seedVm0ManagedModelKey(context, "gpt-5.6-terra");

    expect(first.selectedModel).toBe("gpt-5.6-terra");
    expect(second.selectedModel).toBe("gpt-5.6-terra");

    await expect(first.release()).resolves.toBeUndefined();
    await expect(second.release()).resolves.toBeUndefined();
  });
});
