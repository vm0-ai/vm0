/**
 * Disconnect interaction tests for the /connectors page.
 *
 * Regression coverage for #10272: after a user connected a connector in the
 * same session (api-token or OAuth), the optimistic "just connected" override
 * (justConnectedTypes$) kept the card in the Connected section even after a
 * successful disconnect, because the set was never cleaned up on disconnect.
 */

import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import {
  setPermissionDialogType$,
  submitApiToken$,
} from "../../../signals/zero-page/settings/connectors.ts";
import { mockConnectors } from "./zero-connectors-page-test-helpers.ts";

const context = testContext();

test("disconnect moves a just-connected connector back to an available card (regression #10272)", async () => {
  // Start with Ahrefs already connected — mirrors the screenshot in #10272.
  mockConnectors([{ type: "ahrefs" }]);

  // Populate justConnectedTypes$ as if the user connected Ahrefs earlier in
  // this session via the api-token flow, then dismiss the post-connect
  // permission dialog so it doesn't swallow clicks in this test.
  await context.store.set(
    submitApiToken$,
    "ahrefs",
    { AHREFS_API_KEY: "test" },
    {},
    context.signal,
  );
  context.store.set(setPermissionDialogType$, null);

  detachedSetupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(screen.getByLabelText("More options")).toBeInTheDocument();
  });

  click(screen.getByLabelText("More options"));
  click(screen.getByText("Disconnect"));

  // After a successful disconnect the connector must render as an available
  // card again, even if it was marked as just connected earlier in the session.
  await waitFor(() => {
    expect(screen.queryByLabelText("More options")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Connect Ahrefs")).toBeInTheDocument();
  });
});
