import { describe, expect, it } from "vitest";
import { testContext } from "./test-helpers";
import { setupPage } from "../../__tests__/helper";

const context = testContext();
describe("global method", () => {
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

    expect(loggers.Promise.debug).toBeTruthy();
  });
});
