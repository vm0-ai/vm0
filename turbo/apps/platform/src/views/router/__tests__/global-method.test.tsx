import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";

const context = testContext();
const TEST_SHA = "0123456789abcdef0123456789abcdef01234567";
const TEST_VERSION = "0.540.0";
const debugLoggerStorage = localStorageSignals("debugLogger");

describe("global method", () => {
  it("exposes the app build commit SHA after bootstrap", async () => {
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(window._vm0?.getBuildCommitSha()).toBe(TEST_SHA);
      expect(window._vm0?.getBuildVersion()).toBe(TEST_VERSION);
    });
  });

  it("persists enabled debug loggers through the storage signal", async () => {
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(window._vm0).toBeDefined();
    });

    const loggerControl = window._vm0?.loggers.GlobalMethod;
    expect(loggerControl).toBeDefined();
    if (!loggerControl) {
      throw new Error("GlobalMethod logger control was not registered");
    }

    loggerControl.debug = true;

    expect(context.store.get(debugLoggerStorage.get$)).toBe(
      JSON.stringify(["GlobalMethod"]),
    );
  });
});
