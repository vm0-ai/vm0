import { testContext } from "../signals/__tests__/test-helpers";
import { setupPage } from "./page-helper";
import { expect, it, describe, beforeAll, vi } from "vitest";
import { Level, logger } from "../signals/log";
import { localStorageSignals } from "../signals/external/local-storage";

const context = testContext();

beforeAll(() => {
  // suppress console logs because these cases are not intented to test logging functionality
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

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
    const { set$ } = localStorageSignals("debugLogger");
    context.store.set(set$, JSON.stringify(["Foo"]));

    await setupPage({
      context,
      path: "/",
    });

    expect(logger("Foo").level).toBe(Level.Debug);
  });
});
