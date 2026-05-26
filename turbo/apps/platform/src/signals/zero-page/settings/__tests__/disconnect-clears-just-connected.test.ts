/**
 * Regression test for #10272.
 *
 * `justConnectedTypes$` is populated by the connect flow so the UI doesn't
 * flash between "connecting" and "connected". The disconnect flow must clear
 * that flag, otherwise the Connectors page keeps the card in the Connected
 * section after a successful disconnect (because the optimistic override
 * overrides the freshly-fetched `connected=false`).
 */

import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../../__tests__/page-helper.ts";
import { mockConnectors } from "../../../../views/zero-page/__tests__/zero-connectors-page-test-helpers.ts";
import {
  disconnectConnector$,
  justConnectedTypes$,
  submitManualCredentials$,
} from "../connectors.ts";

const context = testContext();

describe("deleteConnector$ + justConnectedTypes$", () => {
  it("clears the optimistic just-connected flag on successful disconnect", async () => {
    mockConnectors([{ type: "ahrefs" }]);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(
      submitManualCredentials$,
      {
        type: "ahrefs",
        authMethod: "api-token",
        inputSecrets: { AHREFS_API_KEY: "test" },
        options: {},
      },
      context.signal,
    );

    expect(context.store.get(justConnectedTypes$).has("ahrefs")).toBeTruthy();

    await context.store.set(disconnectConnector$, "ahrefs", context.signal);

    expect(context.store.get(justConnectedTypes$).has("ahrefs")).toBeFalsy();
  });
});
