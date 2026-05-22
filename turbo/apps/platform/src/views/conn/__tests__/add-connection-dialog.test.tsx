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
  zeroConnectorOauthStartContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroCliAuthStripeContract } from "@vm0/api-contracts/contracts/zero-connectors-cli-auth-stripe";
import { zeroSecretsContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setSelectedConnectorType$ } from "../../../signals/zero-page/settings/connectors.ts";
import { mockConnectors } from "../../zero-page/__tests__/zero-connectors-page-test-helpers.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  setMockOauthDeviceAuthSessionStartResponse,
  setMockOauthDeviceAuthSessionPollResponses,
  setMockStripeCliAuthCompleteResponse,
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
  const button = screen.getAllByRole("button").find((element) => {
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
    await openConnectModal("local-agent");

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

  it("hides Stripe CLI auth when the feature switch is disabled", async () => {
    await openConnectModal("stripe");

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    expect(screen.queryByText("Sign in with Stripe")).not.toBeInTheDocument();
  });

  it("shows Stripe CLI auth in the Stripe modal when enabled", async () => {
    await openConnectModal("stripe", {
      featureSwitches: {
        [FeatureSwitchKey.CliAuthStripe]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with Stripe")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("heading", { name: "API Key" }),
    ).toBeInTheDocument();
  });

  it("does not show Stripe CLI auth for unsupported connectors", async () => {
    await openConnectModal("axiom", {
      featureSwitches: { [FeatureSwitchKey.CliAuthStripe]: true },
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    expect(screen.queryByText("Sign in with Stripe")).not.toBeInTheDocument();
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

  it("keeps manual Stripe API key save available when CLI auth is enabled", async () => {
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

    await openConnectModal("stripe", {
      featureSwitches: { [FeatureSwitchKey.CliAuthStripe]: true },
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText("sk_live_...")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("sk_live_..."), "sk_test_key");
    click(screen.getByText("Save"));

    await waitFor(() => {
      expect(submittedSecret).toStrictEqual({
        name: "STRIPE_TOKEN",
        value: "sk_test_key",
      });
    });
  });

  it("starts Stripe CLI auth only after selecting a configured mode", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: false, opener: {} } as Window);
    setMockStripeCliAuthCompleteResponse({
      status: "pending",
      errorMessage: null,
    });

    await openConnectModal("stripe", {
      featureSwitches: { [FeatureSwitchKey.CliAuthStripe]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with Stripe")).toBeInTheDocument();
    });

    const startButton = getButtonByText("Select a mode to continue");
    expect(startButton).toBeDisabled();

    expect(getButtonByText(/Test mode/)).toHaveTextContent(
      "Import a Stripe test mode key.",
    );
    expect(getButtonByText(/Live mode/)).toHaveTextContent(
      "Import a Stripe live mode key.",
    );

    click(getButtonByText(/Test mode/));
    const selectedModeStartButton = getButtonByText("Sign in with Stripe");
    expect(selectedModeStartButton).toBeEnabled();

    click(selectedModeStartButton);

    await waitFor(() => {
      expect(screen.getByText("stripe-code-123")).toBeInTheDocument();
    });
    expect(openSpy).not.toHaveBeenCalled();
    expect(
      screen.getByText("Open the approval page to continue."),
    ).toBeInTheDocument();

    click(getButtonByText("Open approval page"));

    expect(openSpy).toHaveBeenCalledWith(
      "https://dashboard.stripe.com/stripecli/confirm_auth",
      "_blank",
    );
    expect(openSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText("Waiting for approval...")).toBeInTheDocument();
    });

    click(screen.getByLabelText(/close/i));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("keeps Stripe CLI auth open when completion is still pending", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      closed: false,
      opener: {},
    } as Window);
    setMockStripeCliAuthCompleteResponse({
      status: "pending",
      errorMessage: "Approval is still pending",
    });

    await openConnectModal("stripe", {
      featureSwitches: { [FeatureSwitchKey.CliAuthStripe]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with Stripe")).toBeInTheDocument();
    });

    click(getButtonByText(/Test mode/));
    click(getButtonByText("Sign in with Stripe"));

    await waitFor(() => {
      expect(screen.getByText("stripe-code-123")).toBeInTheDocument();
    });

    click(getButtonByText("Open approval page"));

    await waitFor(() => {
      expect(screen.getByText("Approval is still pending")).toBeInTheDocument();
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    click(screen.getByLabelText(/close/i));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("stops polling when Stripe CLI auth completion returns a terminal failure", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      closed: false,
      opener: {},
    } as Window);
    let completeCalls = 0;
    server.use(
      mockApi(zeroCliAuthStripeContract.complete, ({ respond }) => {
        completeCalls++;
        return respond(503, {
          error: {
            message: "Stripe CLI config did not contain a test mode API key",
            code: "CLI_AUTH_STRIPE_FAILED",
          },
        });
      }),
    );

    await openConnectModal("stripe", {
      featureSwitches: { [FeatureSwitchKey.CliAuthStripe]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with Stripe")).toBeInTheDocument();
    });

    click(getButtonByText(/Test mode/));
    click(getButtonByText("Sign in with Stripe"));

    await waitFor(() => {
      expect(screen.getByText("stripe-code-123")).toBeInTheDocument();
    });
    click(getButtonByText("Open approval page"));

    await waitFor(() => {
      expect(
        screen.getByText("Stripe config did not contain a test mode API key"),
      ).toBeInTheDocument();
    });

    expect(completeCalls).toBe(1);
    expect(screen.queryByText("Open approval page")).not.toBeInTheDocument();
    expect(getButtonByText("Sign in with Stripe")).toBeEnabled();

    click(screen.getByLabelText(/close/i));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("completes Stripe CLI auth and opens the post-connect permission dialog", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: false, opener: {} } as Window);

    await openConnectModal("stripe", {
      featureSwitches: { [FeatureSwitchKey.CliAuthStripe]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with Stripe")).toBeInTheDocument();
    });

    click(getButtonByText(/Test mode/));
    click(getButtonByText("Sign in with Stripe"));

    await waitFor(() => {
      expect(screen.getByText("stripe-code-123")).toBeInTheDocument();
    });
    expect(openSpy).not.toHaveBeenCalled();

    click(getButtonByText("Open approval page"));

    await waitFor(() => {
      expect(
        screen.getByText("You've successfully connected with Stripe!"),
      ).toBeInTheDocument();
    });
    expect(openSpy).toHaveBeenCalledWith(
      "https://dashboard.stripe.com/stripecli/confirm_auth",
      "_blank",
    );
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("stripe-code-123")).not.toBeInTheDocument();

    click(screen.getByText("Later"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
    vi.spyOn(window, "open").mockReturnValue(null);
    setMockStripeCliAuthCompleteResponse({
      status: "pending",
      errorMessage: null,
    });

    await openConnectModal("stripe", {
      featureSwitches: { [FeatureSwitchKey.CliAuthStripe]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with Stripe")).toBeInTheDocument();
    });

    click(getButtonByText(/Test mode/));
    click(getButtonByText("Sign in with Stripe"));

    await waitFor(() => {
      expect(screen.getByText("stripe-code-123")).toBeInTheDocument();
    });

    click(document.body);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("stripe-code-123")).toBeInTheDocument();

    click(screen.getByLabelText(/close/i));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("clears Stripe CLI auth state when the dialog closes", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    await openConnectModal("stripe", {
      featureSwitches: { [FeatureSwitchKey.CliAuthStripe]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with Stripe")).toBeInTheDocument();
    });

    click(getButtonByText(/Test mode/));
    click(getButtonByText("Sign in with Stripe"));

    await waitFor(() => {
      expect(screen.getByText("stripe-code-123")).toBeInTheDocument();
    });

    click(screen.getByLabelText(/close/i));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    context.store.set(setSelectedConnectorType$, "stripe");

    await waitFor(() => {
      expect(screen.getByText("Sign in with Stripe")).toBeInTheDocument();
    });

    expect(screen.queryByText("stripe-code-123")).not.toBeInTheDocument();
    expect(getButtonByText("Select a mode to continue")).toBeDisabled();
  });

  it("clears Stripe CLI auth state when switching connectors", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    await openConnectModal("stripe", {
      featureSwitches: { [FeatureSwitchKey.CliAuthStripe]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in with Stripe")).toBeInTheDocument();
    });

    click(getButtonByText(/Test mode/));
    click(getButtonByText("Sign in with Stripe"));

    await waitFor(() => {
      expect(screen.getByText("stripe-code-123")).toBeInTheDocument();
    });

    context.store.set(setSelectedConnectorType$, "axiom");

    await waitFor(() => {
      expect(screen.getByText("Save")).toBeInTheDocument();
    });

    context.store.set(setSelectedConnectorType$, "stripe");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Stripe" }),
      ).toBeInTheDocument();
    });

    expect(screen.queryByText("stripe-code-123")).not.toBeInTheDocument();
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
