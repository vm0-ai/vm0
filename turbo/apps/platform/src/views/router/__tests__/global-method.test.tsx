import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const TEST_SHA = "0123456789abcdef0123456789abcdef01234567";
const TEST_VERSION = "global-method-store-version";

describe("global method", () => {
  it("exposes the app build commit SHA after bootstrap", async () => {
    detachedSetupPage({ appVersion: TEST_VERSION, context, path: "/" });

    await waitFor(() => {
      expect(window._vm0?.getBuildCommitSha()).toBe(TEST_SHA);
      expect(window._vm0?.getBuildVersion()).toBe(TEST_VERSION);
    });
  });

  it("enables debug loggers through the public global method", async () => {
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(window._vm0).toBeDefined();
    });

    const loggerControl = window._vm0?.loggers.GlobalMethod;
    expect(loggerControl).toBeDefined();
    if (!loggerControl) {
      throw new Error("GlobalMethod logger control was not registered");
    }

    const storage = context.mocks.browser.localStorageWrites();
    loggerControl.debug = true;

    expect(window._vm0?.loggers.GlobalMethod?.debug).toBeTruthy();
    expect(storage.writes).toContainEqual({
      key: "debugLogger",
      value: JSON.stringify(["GlobalMethod"]),
    });
  });
});
