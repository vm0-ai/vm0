import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { permissionDialogType$ } from "../../../signals/zero-page/settings/connectors.ts";
import {
  type ConnectorListResponse,
  zeroConnectorsMainContract,
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/core";
import { mockApi } from "../../../mocks/msw-contract.ts";

vi.mock("signal-timers", async (importOriginal) => {
  const mod = await importOriginal<typeof import("signal-timers")>();
  return {
    ...mod,
    delay: () => {
      return Promise.resolve();
    },
  };
});

const context = testContext();

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

describe("onboarding connector permission dialog suppression", () => {
  it("should not set permissionDialogType$ after OAuth connect during onboarding", async () => {
    const user = userEvent.setup();
    mockAdminOnboarding();

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    detachedSetupPage({ context, path: "/onboarding" });

    // Step 1: Workspace name
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Test Workspace");
    await user.click(screen.getByText("Next"));

    // Step 2: Choose your tools — select GitHub
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("connector-card-github"));
    await user.click(screen.getByText("Next"));

    // Step 3: Connect your apps
    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
    });

    // Mock the connectors API to return GitHub as connected (simulates
    // successful OAuth — the polling inside connectConnector$ will pick it up).
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        return respond(200, makeGithubConnectedResponse());
      }),
    );

    // Click "Connect" on GitHub — this triggers connectConnector$ which
    // normally sets permissionDialogType$, but the onboarding wrapper
    // clears it immediately after.
    await user.click(screen.getByText("Connect"));

    // Wait for connector to show as connected
    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    // The key assertion: permissionDialogType$ should be null because the
    // onboarding component clears it after connectConnector$ completes.
    // Without the fix, this would be "github".
    await waitFor(() => {
      expect(context.store.get(permissionDialogType$)).toBeNull();
    });
  });
});
