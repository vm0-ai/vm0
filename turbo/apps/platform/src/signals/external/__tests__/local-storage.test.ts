import { describe, it, expect } from "vitest";
import { testContext } from "../../__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import { localStorageSignals } from "../local-storage";

const context = testContext();

describe("local storage signal", () => {
  it("can read and write to local storage", async () => {
    await setupPage({ context, path: "/" });

    const { get$, set$, clear$ } = localStorageSignals("foo");
    expect(context.store.get(get$)).toBeNull();

    context.store.set(set$, "bar");
    expect(context.store.get(get$)).toBe("bar");

    context.store.set(clear$);
    expect(context.store.get(get$)).toBeNull();
  });

  it("should clear after last test", async () => {
    await setupPage({ context, path: "/" });

    const { get$ } = localStorageSignals("foo");
    expect(context.store.get(get$)).toBeNull();
  });
});
