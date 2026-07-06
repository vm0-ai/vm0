import { describe, expect, it } from "vitest";

import { createTestMocks } from "./test-mocks.ts";

describe("test mocks", () => {
  it("rejects deferred promises when the backing signal aborts", async () => {
    const reason = new Error("Aborted due to finished test");
    reason.name = "AbortError";
    const signal = AbortSignal.abort(reason);
    const mocks = createTestMocks(() => {
      return signal;
    });

    const deferred = mocks.deferred<void>();

    await expect(deferred.promise).rejects.toBe(reason);
    expect(deferred.settled()).toBeTruthy();
  });
});
