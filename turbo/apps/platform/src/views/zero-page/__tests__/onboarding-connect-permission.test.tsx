import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { permissionDialogType$ } from "../../../signals/zero-page/settings/connectors.ts";
import type { ConnectorListResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import {
  zeroConnectorOauthStartContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { triggerAblyEvent, hasSubscription } from "../../../mocks/ably.ts";

const context = testContext();
const mockApi = createMockApi(context);

function makeGithubConnectedResponse(): ConnectorListResponse {
  return {
    connectors: [
      {
        id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        type: "github",
        authMethod: "oauth",
        externalId: "12345",
        externalUsername: "testuser",
        externalEmail: "test@example.com",
        oauthScopes: ["repo", "read:user"],
        needsReconnect: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    configuredTypes: ["github"],
    connectorProvidedSecretNames: [],
  };
}

function mockAdminOnboarding() {
  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: true,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
      });
    }),
    mockApi(onboardingSetupContract.setup, ({ respond }) => {
      return respond(200, { agentId: "d0000000-0000-4000-a000-000000000001" });
    }),
  );
}

function mockConnectorOauthStart() {
  server.use(
    mockApi(zeroConnectorOauthStartContract.start, ({ params, respond }) => {
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.type}/authorize`,
      });
    }),
  );
}

function createMockAuthWindow() {
  return { closed: false, close: vi.fn(), location: { href: "" } };
}

describe("onboarding connector permission dialog suppression", () => {
  it("should not set permissionDialogType$ after OAuth connect during onboarding", async () => {
    mockAdminOnboarding();
    mockConnectorOauthStart();

    const mockWindow = createMockAuthWindow();
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    // A use-case deep link drives the admin flow into the condensed step-3
    // flow — the only place the per-connector Connect UI appears.
    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hello&connector=github",
    });

    // Step 1: Workspace name
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Test Workspace");
    click(screen.getByText("Next"));

    // Step 3: Connect your apps (github pre-selected from the deep link)
    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
    });

    // Mock the connectors API to return GitHub as connected (simulates
    // successful auth-code OAuth — the polling inside
    // connectConnectorOAuthAuthCode$ will pick it up).
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        return respond(200, makeGithubConnectedResponse());
      }),
    );

    // Click "Connect" on GitHub — this triggers
    // connectConnectorOAuthAuthCode$ without opting into the post-connect
    // permission dialog.
    click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(mockWindow.location.href).toBe(
        "https://oauth.test/github/authorize",
      );
    });

    // Wait for the Ably subscription to be registered, then simulate the
    // Auth-code OAuth callback publishing `connector:changed` so
    // connectConnectorOAuthAuthCode$ observes the connector appear.
    await waitFor(() => {
      expect(hasSubscription("connector:changed")).toBeTruthy();
    });
    triggerAblyEvent("connector:changed");

    // Wait for connector to show as connected
    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    // The key assertion: permissionDialogType$ should be null outside the
    // connectors page.
    await waitFor(() => {
      expect(context.store.get(permissionDialogType$)).toBeNull();
    });
  });
});
