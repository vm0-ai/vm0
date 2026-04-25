/**
 * Interaction tests for the /connectors page (ZeroConnectorsPage component).
 *
 * Tests user interactions (connect, reconnect, review) via setupPage following
 * platform testing principles:
 * - Entry point: setupPage({ path: "/connectors" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { mockConnectors } from "./zero-connectors-page-test-helpers.ts";
import { zeroConnectorScopeDiffContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

test("connect button opens api-token form (CONN-I-011)", async () => {
  detachedSetupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(screen.getByLabelText("Connect Axiom")).toBeInTheDocument();
  });

  click(screen.getByLabelText("Connect Axiom"));

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  expect(screen.getByText("Save")).toBeInTheDocument();
});

test("connect button on Google connector opens dialog with OAuth notice (CONN-I-020)", async () => {
  detachedSetupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(screen.getByLabelText("Connect Gmail")).toBeInTheDocument();
  });

  click(screen.getByLabelText("Connect Gmail"));

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  expect(
    screen.getByText(/Google will show a security warning/),
  ).toBeInTheDocument();
  expect(screen.getByText("Advanced")).toBeInTheDocument();
  expect(screen.getByText(/Go to vm0\.ai \(unsafe\)/)).toBeInTheDocument();
});

test("connect button on api-token-only connector opens dialog without OAuth notice (CONN-I-021)", async () => {
  detachedSetupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(screen.getByLabelText("Connect Axiom")).toBeInTheDocument();
  });

  click(screen.getByLabelText("Connect Axiom"));

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  expect(
    screen.queryByText(/Google will show a security warning/),
  ).not.toBeInTheDocument();
});

test("review button opens scope diff with added permissions (CONN-I-013)", async () => {
  mockConnectors([{ type: "github", oauthScopes: [] }]);

  server.use(
    mockApi(zeroConnectorScopeDiffContract.getScopeDiff, ({ respond }) => {
      return respond(200, {
        addedScopes: ["repo", "project"],
        removedScopes: [],
        currentScopes: [],
        storedScopes: ["repo", "project"],
      });
    }),
  );

  detachedSetupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  click(screen.getByText("Review"));

  await waitFor(() => {
    expect(screen.getByText("repo")).toBeInTheDocument();
  });
  expect(screen.getByText("project")).toBeInTheDocument();
});
