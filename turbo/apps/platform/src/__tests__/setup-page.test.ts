import { testContext } from "../signals/__tests__/test-helpers";
import { detachedSetupPage } from "./page-helper";
import { expect, it, describe } from "vitest";
import { Level, logger } from "../signals/log";
import { localStorageSignals } from "../signals/external/local-storage";

const context = testContext();

describe("setupPage", () => {
  it("should set debug loggers correctly", () => {
    detachedSetupPage({
      context,
      path: "/",
      debugLoggers: ["Foo"],
    });

    expect(logger("Foo").level).toBe(Level.Debug);
  });

  it("should load debug loggers correctly", () => {
    const { set$ } = localStorageSignals("debugLogger");
    context.store.set(set$, JSON.stringify(["Foo"]));

    detachedSetupPage({
      context,
      path: "/",
    });

    expect(logger("Foo").level).toBe(Level.Debug);
  });
});
