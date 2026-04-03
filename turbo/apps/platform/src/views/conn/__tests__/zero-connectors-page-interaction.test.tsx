/**
 * Interaction tests for the /connectors page (ZeroConnectorsPage component).
 *
 * Tests user interactions (search, connect, reconnect, review, disconnect)
 * via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/connectors" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { afterEach, expect, test, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockConnectors } from "../../zero-page/__tests__/zero-connectors-page-test-helpers.ts";

const context = testContext();

afterEach(() => {
  vi.restoreAllMocks();
});

test("search input filters connector list (CONN-I-010)", async () => {
  const user = userEvent.setup();
  await setupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  const searchInput = screen.getByPlaceholderText("Search connectors");
  await user.type(searchInput, "github");

  await waitFor(() => {
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });
  expect(screen.queryByText("Slack")).not.toBeInTheDocument();
});

test("connect button initiates connection (CONN-I-011)", async () => {
  const user = userEvent.setup();
  await setupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Connect Axiom" }),
    ).toBeInTheDocument();
  });

  await user.click(screen.getByRole("button", { name: "Connect Axiom" }));

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  expect(screen.getByRole("dialog")).toHaveTextContent("Axiom");
});

test("reconnect button triggers reconnection flow (CONN-I-012)", async () => {
  const user = userEvent.setup();
  mockConnectors([{ type: "github", needsReconnect: true }]);

  const openSpy = vi
    .spyOn(window, "open")
    .mockReturnValue({ closed: false } as Window);

  await setupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(screen.getByText("Reconnect")).toBeInTheDocument();
  });

  await user.click(screen.getByText("Reconnect"));

  expect(openSpy).toHaveBeenCalledWith(
    expect.stringContaining("/api/zero/connectors/github/authorize"),
    "_blank",
    expect.any(String),
  );
});

test("review button opens ScopeReviewModal (CONN-I-013)", async () => {
  const user = userEvent.setup();
  mockConnectors([{ type: "github", oauthScopes: [] }]);

  server.use(
    http.get("*/api/zero/connectors/:type/scope-diff", () => {
      return HttpResponse.json({
        addedScopes: ["repo", "project"],
        removedScopes: [],
      });
    }),
  );

  await setupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  await user.click(screen.getByText("Review"));

  await waitFor(() => {
    expect(screen.getByText("GitHub — Permissions Update")).toBeInTheDocument();
  });
});

test("dropdown menu shows Disconnect option (CONN-I-014)", async () => {
  const user = userEvent.setup();
  mockConnectors([
    {
      type: "github",
      externalUsername: "octocat",
      oauthScopes: ["repo", "project"],
    },
  ]);

  await setupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "More options" }),
    ).toBeInTheDocument();
  });

  await user.click(screen.getByRole("button", { name: "More options" }));

  await waitFor(() => {
    expect(
      screen.getByRole("menuitem", { name: "Disconnect" }),
    ).toBeInTheDocument();
  });
});

test("disconnect option disconnects the connector (CONN-I-015)", async () => {
  const user = userEvent.setup();

  let callCount = 0;
  server.use(
    http.get("*/api/zero/connectors", () => {
      callCount++;
      if (callCount === 1) {
        return HttpResponse.json({
          connectors: [
            {
              id: "a0000000-0000-4000-a000-000000000001",
              type: "github",
              authMethod: "oauth",
              externalId: null,
              externalUsername: "octocat",
              externalEmail: null,
              oauthScopes: ["repo", "project"],
              needsReconnect: false,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
          configuredTypes: ["github"],
          connectorProvidedSecretNames: [],
        });
      }
      return HttpResponse.json({
        connectors: [],
        configuredTypes: ["github"],
        connectorProvidedSecretNames: [],
      });
    }),
    http.delete("*/api/zero/connectors/:type", () => {
      return new HttpResponse(null, { status: 204 });
    }),
  );

  await setupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(screen.getByText(/Connected \(/)).toBeInTheDocument();
  });

  const moreButton = screen.getByRole("button", { name: "More options" });
  await user.click(moreButton);

  await waitFor(() => {
    expect(
      screen.getByRole("menuitem", { name: "Disconnect" }),
    ).toBeInTheDocument();
  });
  await user.click(screen.getByRole("menuitem", { name: "Disconnect" }));

  await waitFor(() => {
    expect(screen.queryByText(/Connected \(/)).not.toBeInTheDocument();
  });
});
