import { describe, expect, it } from "vitest";
import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";

import {
  forceUpgradeDialogOpen$,
  listenForceUpgradeDialog$,
  reportForceUpgradeRequired,
  reportForceUpgradeResponse,
} from "../force-upgrade.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

describe("force upgrade signal", () => {
  it("opens the force upgrade dialog when a response requires it", () => {
    context.store.set(listenForceUpgradeDialog$, context.signal);

    expect(context.store.get(forceUpgradeDialogOpen$)).toBeFalsy();

    expect(
      reportForceUpgradeResponse({ status: CLIENT_FORCE_UPGRADE_STATUS }),
    ).toBeTruthy();
    expect(context.store.get(forceUpgradeDialogOpen$)).toBeTruthy();
  });

  it("ignores non-force-upgrade responses", () => {
    expect(reportForceUpgradeResponse({ status: 200 })).toBeFalsy();
  });

  it("reports force upgrade requirements without polling", () => {
    context.store.set(listenForceUpgradeDialog$, context.signal);

    reportForceUpgradeRequired();

    expect(context.store.get(forceUpgradeDialogOpen$)).toBeTruthy();
  });
});
