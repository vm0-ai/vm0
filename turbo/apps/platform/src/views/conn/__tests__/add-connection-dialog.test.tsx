/**
 * Tests for ConnectModal (add-connection-dialog.tsx) and ConnectorIcon (connector-icons.tsx).
 *
 * Tests page-level behavior via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/connectors" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { type ConnectorType, zeroConnectorsMainContract } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setSelectedConnectorType$ } from "../../../signals/zero-page/settings/connectors.ts";
import { mockConnectors } from "../../zero-page/__tests__/zero-connectors-page-test-helpers.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();

async function openConnectModal(connectorType: ConnectorType) {
  detachedSetupPage({ context, path: "/connectors" });
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
});

describe("connect modal - loading states", () => {
  it("shows Connecting... while OAuth is in progress (CONN-D-020)", async () => {
    // Keep popup "open" so polling never exits
    vi.spyOn(window, "open").mockReturnValue({ closed: false } as Window);

    // Allow the initial connectors load to succeed (returns empty), then block
    // subsequent polling calls so the polling loop stays in flight.
    let callCount = 0;
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        callCount++;
        if (callCount === 1) {
          return respond(200, {
            connectors: [],
            configuredTypes: [],
            connectorProvidedSecretNames: [],
          });
        }
        return new Promise<never>(() => {
          // Never resolves — keeps polling in flight
        });
      }),
    );

    await openConnectModal("github");

    await waitFor(() => {
      expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Sign in with GitHub"));

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

    const user = userEvent.setup();
    await user.click(screen.getByText("Sign in with GitHub"));

    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/zero/connectors/github/authorize"),
      "_blank",
      expect.any(String),
    );
  });

  it("save button submits API token secrets (CONN-I-023)", async () => {
    const user = userEvent.setup();
    let submittedSecret: { name: string; value: string } | undefined;

    server.use(
      http.post("*/api/zero/secrets", async ({ request }) => {
        submittedSecret = (await request.json()) as {
          name: string;
          value: string;
        };
        return HttpResponse.json(
          {
            id: crypto.randomUUID(),
            name: submittedSecret.name,
            type: "user",
            description: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { status: 201 },
        );
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
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(submittedSecret).toBeDefined();
      expect(submittedSecret?.name).toBe("AXIOM_TOKEN");
      expect(submittedSecret?.value).toBe("test-token-value");
    });
  });
});

describe("connect modal - state management", () => {
  it("dialog opens and closes correctly (CONN-S-024)", async () => {
    const user = userEvent.setup();
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
    await user.click(closeButton);

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
