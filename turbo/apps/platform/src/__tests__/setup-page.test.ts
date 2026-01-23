import { testContext } from "../signals/__tests__/test-helpers";
import { setupPage } from "./helper";
import { expect, it, describe } from "vitest";
import { Level, logger } from "../signals/log";
import { localStorageSignals } from "../signals/external/local-storage";

const context = testContext();

describe("setupPage", () => {
  it("should set debug loggers correctly", async () => {
    await setupPage({
      context,
      path: "/",
      debugLoggers: ["Foo"],
    });

    expect(logger("Foo").level).toBe(Level.Debug);
  });

  it("should load debug loggers correctly", async () => {
    const { set$ } = localStorageSignals("debugLoggers");
    context.store.set(set$, JSON.stringify(["Foo"]));

    await setupPage({
      context,
      path: "/",
    });

    expect(logger("Foo").level).toBe(Level.Debug);
  });
});
