import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { testContext } from "./test-helpers";
import { detachedSetupPage } from "../../__tests__/page-helper";
import { getMockFeatureSwitches } from "../../mocks/handlers/api-feature-switches";

const context = testContext();

describe("global debug loggers", () => {
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

describe("global feature switches", () => {
  it("should have featureSwitches after init", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    await waitFor(() => {
      expect(window._vm0).toBeDefined();
      expect(window._vm0?.featureSwitches.dummy).toBeTruthy();
    });
  });

  it("should override feature switch when set value", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dummy: false },
      withoutRender: true,
    });

    await waitFor(() => {
      expect(window._vm0?.featureSwitches.dummy).toBeFalsy();
    });
  });

  it("should write through to server when setter used", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    await waitFor(() => {
      expect(window._vm0?.featureSwitches).toBeDefined();
    });

    window._vm0!.featureSwitches.dummy = false;

    await waitFor(() => {
      expect(getMockFeatureSwitches()).toMatchObject({ dummy: false });
    });
  });
});
