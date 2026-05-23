import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { testContext } from "./test-helpers";
import { detachedSetupPage } from "../../__tests__/page-helper";

const context = testContext();

describe("global debug loggers", () => {
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

  it("should has vm0 method after init", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    await waitFor(() => {
      expect(window._vm0).toBeDefined();
    });
  });

  it("should init all loggers in info level", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    await waitFor(() => {
      const loggers = window._vm0?.loggers;
      expect(loggers).toBeDefined();
      if (loggers) {
        for (const loggerName of Object.keys(loggers)) {
          expect(loggers[loggerName].debug).toBeFalsy();
        }
      }
    });
  });

  it("should set logger to debug level when set debug to true", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    await waitFor(() => {
      expect(window._vm0?.loggers).toBeDefined();
    });

    const loggers = window._vm0!.loggers;
    loggers.Promise.debug = true;
    expect(loggers.Promise.debug).toBeTruthy();
  });

  it("should affected by setupPage debugLoggers", async () => {
    detachedSetupPage({
      context,
      path: "/",
      debugLoggers: ["Promise"],
      withoutRender: true,
    });

    await waitFor(() => {
      expect(window._vm0?.loggers?.Promise.debug).toBeTruthy();
    });
  });
});
