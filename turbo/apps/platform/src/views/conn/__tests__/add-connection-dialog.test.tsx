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
import {
  zeroConnectorApiTokenContract,
  zeroConnectorOauthStartContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { setSelectedConnectorType$ } from "../../../signals/zero-page/settings/connectors.ts";
import { mockConnectors } from "../../zero-page/__tests__/zero-connectors-page-test-helpers.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  setMockOauthDeviceAuthSessionStartResponse,
  setMockOauthDeviceAuthSessionPollResponses,
} from "../../../mocks/handlers/api-connectors.ts";

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

function elementTextMatches(
  element: HTMLElement,
  matcher: string | RegExp,
): boolean {
  const text = element.textContent?.trim() ?? "";
  return typeof matcher === "string" ? text === matcher : matcher.test(text);
}

function getButtonByText(matcher: string | RegExp): HTMLElement {
  const button = queryAllByRoleFast("button").find((element) => {
    return elementTextMatches(element, matcher);
  });
  if (!button) {
    throw new Error(`Button not found: ${String(matcher)}`);
  }
  return button;
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

function apiTokenConnectorResponse(type: ConnectorType) {
  return {
    id: null,
    type,
    authMethod: "api-token" as const,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    needsReconnect: false,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function createMockAuthWindow(closed: boolean) {
  return { closed, close: vi.fn(), location: { href: "" } };
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

  it("shows device auth code before opening provider verification", async () => {
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(createMockAuthWindow(false) as unknown as Window);
    setMockOauthDeviceAuthSessionPollResponses([
      {
        status: "complete",
        connector: {
          id: "00000000-0000-4000-8000-000000000101",
          type: "test-oauth-device",
          authMethod: "oauth",
          externalId: "test-oauth-device-user",
          externalUsername: "device-user",
          externalEmail: null,
          oauthScopes: ["read"],
          needsReconnect: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    ]);

    await openConnectModal("test-oauth-device", {
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    expect(
      screen.queryByText("Sign in with Test OAuth Device (internal)"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Connection methods unavailable"),
    ).not.toBeInTheDocument();
    await userEvent.click(
      await screen.findByText("Connect Test OAuth Device (internal)"),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-oauth-device-code"),
      ).toHaveTextContent("VM0-DEVICE");
    });
    expect(open).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText("Open verification page"));

    await waitFor(() => {
      expect(open).toHaveBeenCalledWith(
        "https://oauth.test/test-oauth-device/device?user_code=VM0-DEVICE",
        "_blank",
      );
    });
    expect(
      screen.queryByText("Connection methods unavailable"),
    ).not.toBeInTheDocument();
  });

  it("opens the verification URI when the complete verification URI is absent", async () => {
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(createMockAuthWindow(false) as unknown as Window);
    setMockOauthDeviceAuthSessionStartResponse({
      verificationUri: "https://oauth.test/test-oauth-device/manual",
      verificationUriComplete: undefined,
    });
    setMockOauthDeviceAuthSessionPollResponses([
      {
        status: "complete",
        connector: {
          id: "00000000-0000-4000-8000-000000000102",
          type: "test-oauth-device",
          authMethod: "oauth",
          externalId: "test-oauth-device-user",
          externalUsername: "device-user",
          externalEmail: null,
          oauthScopes: ["read"],
          needsReconnect: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    ]);

    await openConnectModal("test-oauth-device", {
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    await userEvent.click(
      await screen.findByText("Connect Test OAuth Device (internal)"),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-oauth-device-code"),
      ).toHaveTextContent("VM0-DEVICE");
    });
    await userEvent.click(getButtonByText("Open verification page"));

    await waitFor(() => {
      expect(open).toHaveBeenCalledWith(
        "https://oauth.test/test-oauth-device/manual",
        "_blank",
      );
    });
  });

  it.each([
    ["denied", "The device request was denied."],
    ["expired", "The device request expired."],
    ["error", "The device request failed."],
  ] as const)(
    "shows terminal device auth %s state with retry",
    async (status, message) => {
      setMockOauthDeviceAuthSessionPollResponses([
        {
          status,
          errorMessage: message,
        },
      ]);

      await openConnectModal("test-oauth-device", {
        featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
      });

      await userEvent.click(
        await screen.findByText("Connect Test OAuth Device (internal)"),
      );
      vi.spyOn(window, "open").mockReturnValue(
        createMockAuthWindow(false) as unknown as Window,
      );
      await userEvent.click(await screen.findByText("Open verification page"));

      await waitFor(() => {
        expect(screen.getByText(message)).toBeInTheDocument();
      });
      expect(screen.getByText("Try again")).toBeInTheDocument();
    },
  );

  it("clears device auth state when the dialog closes", async () => {
    await openConnectModal("test-oauth-device", {
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    await userEvent.click(
      await screen.findByText("Connect Test OAuth Device (internal)"),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-oauth-device-code"),
      ).toHaveTextContent("VM0-DEVICE");
    });

    click(screen.getByLabelText(/close/i));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("connector-oauth-device-code"),
    ).not.toBeInTheDocument();
  });

  it("shows API token form for api-token connectors (CONN-C-019)", async () => {
    await openConnectModal("axiom");

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("shows Local Agent connector-specific API content", async () => {
    await openConnectModal("local-agent", {
      featureSwitches: { [FeatureSwitchKey.LocalAgentConnector]: true },
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
    mockConnectorOauthStart();
    vi.spyOn(window, "open").mockReturnValue(
      createMockAuthWindow(false) as unknown as Window,
    );

    let callCount = 0;
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond, never }) => {
        callCount++;
        if (callCount === 1) {
          return respond(200, {
            connectors: [],
            configuredTypes: [],
            connectorProvidedEnvNames: [],
          });
        }
        return never();
      }),
    );

    await openConnectModal("github", {
      featureSwitches: { [FeatureSwitchKey.LocalAgentConnector]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
    });

    click(screen.getByText("Sign in with GitHub"));

    await waitFor(() => {
      expect(screen.getByText("Connecting...")).toBeInTheDocument();
    });

    context.store.set(setSelectedConnectorType$, "local-agent");

    await waitFor(() => {
      expect(screen.getByText("Online hosts")).toBeInTheDocument();
    });
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).queryByText("Saving permissions..."),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Connecting...")).not.toBeInTheDocument();
  });

  it("shows OAuth and API token content when both auth methods are available", async () => {
    await openConnectModal("deel", {
      featureSwitches: { [FeatureSwitchKey.DeelConnector]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with Deel")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("heading", { name: "OAuth (Recommended)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "API Token" }),
    ).toBeInTheDocument();
    expect(screen.getByText("or")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
  });
});

describe("connect modal - loading states", () => {
  it("shows Connecting... while OAuth is in progress (CONN-D-020)", async () => {
    mockConnectorOauthStart();
    // Keep popup "open" so polling never exits
    vi.spyOn(window, "open").mockReturnValue(
      createMockAuthWindow(false) as unknown as Window,
    );

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
            connectorProvidedEnvNames: [],
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
    mockConnectorOauthStart();
    // Return a closed popup so the connector flow doesn't hang waiting for polling
    const mockWindow = createMockAuthWindow(true);
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(mockWindow as unknown as Window);

    await openConnectModal("github");

    await waitFor(() => {
      expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
    });

    click(screen.getByText("Sign in with GitHub"));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "about:blank",
        "_blank",
        "width=600,height=700",
      );
      expect(mockWindow.location.href).toBe(
        "https://oauth.test/github/authorize",
      );
    });
  });

  it("save button submits API token connector values (CONN-I-023)", async () => {
    const user = userEvent.setup();
    let submittedValues: Record<string, string> | undefined;

    server.use(
      mockApi(zeroConnectorApiTokenContract.connect, ({ body, respond }) => {
        submittedValues = body.values;
        return respond(200, apiTokenConnectorResponse("axiom"));
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
      expect(submittedValues).toStrictEqual({
        AXIOM_TOKEN: "test-token-value",
      });
    });
  });

  it("submits all manual credential fields in one connector request", async () => {
    const user = userEvent.setup();
    let submittedValues: Record<string, string> | undefined;

    server.use(
      mockApi(zeroConnectorApiTokenContract.connect, ({ body, respond }) => {
        submittedValues = body.values;
        return respond(200, apiTokenConnectorResponse("zendesk"));
      }),
    );

    await openConnectModal("zendesk");

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("your-zendesk-api-token"),
      ).toBeInTheDocument();
    });

    await user.type(
      screen.getByPlaceholderText("your-zendesk-api-token"),
      "zendesk-token",
    );
    await user.type(
      screen.getByPlaceholderText("your-email@company.com"),
      "support@example.com",
    );
    await user.type(
      screen.getByPlaceholderText("yourcompany"),
      "example-subdomain",
    );
    click(screen.getByText("Save"));

    await waitFor(() => {
      expect(submittedValues).toStrictEqual({
        ZENDESK_API_TOKEN: "zendesk-token",
        ZENDESK_EMAIL: "support@example.com",
        ZENDESK_SUBDOMAIN: "example-subdomain",
      });
    });
  });

  it("keeps manual Stripe API key save available", async () => {
    const user = userEvent.setup();
    let submittedValues: Record<string, string> | undefined;

    server.use(
      mockApi(zeroConnectorApiTokenContract.connect, ({ body, respond }) => {
        submittedValues = body.values;
        return respond(200, apiTokenConnectorResponse("stripe"));
      }),
    );

    await openConnectModal("stripe");

    await waitFor(() => {
      expect(screen.getByPlaceholderText("sk_live_...")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("sk_live_..."), "sk_test_key");
    click(screen.getByText("Save"));

    await waitFor(() => {
      expect(submittedValues).toStrictEqual({
        STRIPE_TOKEN: "sk_test_key",
      });
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

  it("closes on outside click when no connection flow is active", async () => {
    await openConnectModal("axiom");

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    click(document.body);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("keeps the dialog open on outside click while a connection flow is active", async () => {
    mockConnectorOauthStart();
    vi.spyOn(window, "open").mockReturnValue(
      createMockAuthWindow(false) as unknown as Window,
    );

    await openConnectModal("github");

    await waitFor(() => {
      expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
    });

    click(screen.getByText("Sign in with GitHub"));

    await waitFor(() => {
      expect(screen.getByText("Connecting...")).toBeInTheDocument();
    });

    click(document.body);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Connecting...")).toBeInTheDocument();

    click(screen.getByLabelText(/close/i));
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
