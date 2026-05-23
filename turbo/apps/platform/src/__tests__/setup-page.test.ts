import { testContext } from "../signals/__tests__/test-helpers";
import { detachedSetupPage } from "./page-helper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Level, logger } from "../signals/log";
import { localStorageSignals } from "../signals/external/local-storage";

const context = testContext();

describe("setupPage", () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

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
