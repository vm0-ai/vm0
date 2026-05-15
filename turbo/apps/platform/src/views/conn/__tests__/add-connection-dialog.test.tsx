/**
 * Tests for ConnectModal (add-connection-dialog.tsx) and ConnectorIcon (connector-icons.tsx).
 *
 * Tests page-level behavior via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/connectors" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroConnectorsMainContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroSecretsContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setSelectedConnectorType$ } from "../../../signals/zero-page/settings/connectors.ts";
import { mockConnectors } from "../../zero-page/__tests__/zero-connectors-page-test-helpers.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

async function openConnectModal(
  connectorType: ConnectorType,
  options: {
    featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  } = {},
) {
  detachedSetupPage({
    context,
    path: "/connectors",
    ...options,
  });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Connectors" }),
    ).toBeInTheDocument();
  });
  context.store.set(setSelectedConnectorType$, connectorType);
}

describe("connect modal - display", () => {
  it("shows connector icon and label (CONN-D-016)", async () => {
    await openConnectModal("axiom");

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Label shown in dialog header
    expect(screen.getByRole("heading", { name: "Axiom" })).toBeInTheDocument();

    // Icon rendered as img element inside the dialog
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")).toBeInTheDocument();
  });

  it("shows connected status text when connector is connected (CONN-D-017)", async () => {
    mockConnectors([{ type: "axiom" }]);

    await openConnectModal("axiom");

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });
  });
});

describe("connect modal - content by auth method", () => {
  it("shows OAuth button for OAuth connectors (CONN-C-018)", async () => {
    await openConnectModal("github");

    await waitFor(() => {
      expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
    });
  });

  it("shows API token form for api-token connectors (CONN-C-019)", async () => {
    await openConnectModal("axiom");

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("shows Remote Agent connector-specific API content", async () => {
    await openConnectModal("remote-agent", {
      featureSwitches: { [FeatureSwitchKey.RemoteAgent]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Online hosts")).toBeInTheDocument();
    });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/No online hosts yet/)).toBeInTheDocument();
    expect(within(dialog).queryByText("Save")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Sign in with/)).not.toBeInTheDocument();
  });

  it("shows Local Browser connector-specific API content", async () => {
    await openConnectModal("local-browser", {
      featureSwitches: { [FeatureSwitchKey.LocalBrowserUse]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Browser extension")).toBeInTheDocument();
    });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Browser hosts")).toBeInTheDocument();
    expect(within(dialog).queryByText("Save")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Sign in with/)).not.toBeInTheDocument();
  });

  it("keeps API-only content visible while OAuth is settling elsewhere", async () => {
    vi.spyOn(window, "open").mockReturnValue({ closed: false } as Window);

    let callCount = 0;
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond, never }) => {
        callCount++;
        if (callCount === 1) {
          return respond(200, {
            connectors: [],
            configuredTypes: [],
            connectorProvidedSecretNames: [],
          });
        }
        return never();
      }),
    );

    await openConnectModal("github", {
      featureSwitches: { [FeatureSwitchKey.RemoteAgent]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
    });

    click(screen.getByText("Sign in with GitHub"));

    await waitFor(() => {
      expect(screen.getByText("Connecting...")).toBeInTheDocument();
    });

    context.store.set(setSelectedConnectorType$, "remote-agent");

    await waitFor(() => {
      expect(screen.getByText("Online hosts")).toBeInTheDocument();
    });
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).queryByText("Saving permissions..."),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Connecting...")).not.toBeInTheDocument();
  });

  it("shows OAuth and API token choices when both auth methods are available", async () => {
    await openConnectModal("deel", {
      featureSwitches: { [FeatureSwitchKey.DeelConnector]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with Deel")).toBeInTheDocument();
    });

    expect(screen.getByText("API Token")).toBeInTheDocument();
    expect(screen.getByText("or")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("hides CLI auth when other auth methods have modal UI", async () => {
    await openConnectModal("stripe", {
      featureSwitches: {
        [FeatureSwitchKey.StripeConnector]: true,
        [FeatureSwitchKey.CliAuthStripe]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with Stripe")).toBeInTheDocument();
    });

    expect(
      screen.queryByText("CLI authentication is not available yet"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Stripe CLI")).not.toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
  });
});

describe("connect modal - loading states", () => {
  it("shows Connecting... while OAuth is in progress (CONN-D-020)", async () => {
    // Keep popup "open" so polling never exits
    vi.spyOn(window, "open").mockReturnValue({ closed: false } as Window);

    // Allow the initial connectors load to succeed (returns empty), then block
    // subsequent polling calls so the polling loop stays in flight.
    let callCount = 0;
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond, never }) => {
        callCount++;
        if (callCount === 1) {
          return respond(200, {
            connectors: [],
            configuredTypes: [],
            connectorProvidedSecretNames: [],
          });
        }
        return never();
      }),
    );

    await openConnectModal("github");

    await waitFor(() => {
      expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
    });

    click(screen.getByText("Sign in with GitHub"));

    await waitFor(() => {
      expect(screen.getByText("Connecting...")).toBeInTheDocument();
    });
  });
});

describe("connect modal - interactions", () => {
  it("oAuth button initiates sign-in flow (CONN-I-022)", async () => {
    // Return a closed popup so the connector flow doesn't hang waiting for polling
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: true } as Window);

    await openConnectModal("github");

    await waitFor(() => {
      expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
    });

    click(screen.getByText("Sign in with GitHub"));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/zero/connectors/github/authorize"),
        "_blank",
        expect.any(String),
      );
    });
  });

  it("save button submits API token secrets (CONN-I-023)", async () => {
    const user = userEvent.setup();
    let submittedSecret: { name: string; value: string } | undefined;

    server.use(
      mockApi(zeroSecretsContract.set, ({ body, respond }) => {
        submittedSecret = { name: body.name, value: body.value };
        const now = new Date().toISOString();
        return respond(201, {
          id: crypto.randomUUID(),
          name: body.name,
          type: "user",
          description: body.description ?? null,
          createdAt: now,
          updatedAt: now,
        });
      }),
    );

    await openConnectModal("axiom");

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(
      screen.getByPlaceholderText("xaat-..."),
      "test-token-value",
    );
    click(screen.getByText("Save"));

    await waitFor(() => {
      expect(submittedSecret).toBeDefined();
      expect(submittedSecret?.name).toBe("AXIOM_TOKEN");
      expect(submittedSecret?.value).toBe("test-token-value");
    });
  });
});

describe("connect modal - state management", () => {
  it("dialog opens and closes correctly (CONN-S-024)", async () => {
    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Connectors" }),
      ).toBeInTheDocument();
    });

    // Dialog is initially closed
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Open dialog
    context.store.set(setSelectedConnectorType$, "axiom");

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Close dialog via the close button
    const closeButton = screen.getByLabelText(/close/i);
    click(closeButton);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});

describe("connector icon - via dialog", () => {
  it("renders img element for standard connector types (CONN-D-041)", async () => {
    await openConnectModal("axiom");

    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(dialog.querySelector("img")).toBeInTheDocument();
    });
  });

  it("renders inline SVG for deel connector type (CONN-D-042)", async () => {
    await openConnectModal("deel");

    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(dialog.querySelector("svg")).toBeInTheDocument();
    });
  });
});
