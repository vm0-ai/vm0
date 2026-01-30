import { beforeAll, describe, expect, it, vi } from "vitest";
import { testContext } from "./test-helpers";
import { setupPage } from "../../__tests__/page-helper";

const context = testContext();
beforeAll(() => {
  // suppress console logs because these cases are not intented to test logging functionality
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("global debug loggers", () => {
  it("should has vm0 method after init", async () => {
    await setupPage({ context, path: "/" });

    expect(window._vm0).toBeDefined();
  });

  it("should init all loggers in info level", async () => {
    await setupPage({ context, path: "/" });

    const loggers = window._vm0?.loggers;
    expect(loggers).toBeDefined();
    if (loggers) {
      for (const loggerName of Object.keys(loggers)) {
        expect(loggers[loggerName].debug).toBeFalsy();
      }
    }
  });

  it("should set logger to debug level when set debug to true", async () => {
    await setupPage({ context, path: "/" });

    const loggers = window._vm0?.loggers;
    expect(loggers).toBeDefined();
    if (!loggers) {
      return;
    }

    loggers.Promise.debug = true;
    expect(loggers.Promise.debug).toBeTruthy();
  });

  it("should affected by setupPage debugLoggers", async () => {
    await setupPage({
      context,
      path: "/",
      debugLoggers: ["Promise"],
    });

    const loggers = window._vm0?.loggers;
    expect(loggers).toBeDefined();
    if (!loggers) {
      return;
    }

    expect(loggers.Promise.debug).toBeTruthy();
  });
});

describe("global feature switches", () => {
  it("should have featureSwitches after init", async () => {
    await setupPage({ context, path: "/" });

    expect(window._vm0).toBeDefined();
    expect(window._vm0?.featureSwitches.dummy).toBeTruthy();
  });

  it("should override feature switch when set value", async () => {
    await setupPage({ context, path: "/", featureSwitches: { dummy: false } });

    expect(window._vm0?.featureSwitches.dummy).toBeFalsy();
  });
});
