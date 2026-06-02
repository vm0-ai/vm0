/**
 * Tests for the /connectors/:type/connect page (ZeroDirectedConnectPage).
 *
 * Entry point: setupPage({ path: "/connectors/:type/connect" })
 * Mock (external): connectors API via MSW
 * Real (internal): signals, components, rendering
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorOauthStartContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import {
  setMockConnectors,
  setMockOauthDeviceAuthSessionPollResponses,
} from "../../../mocks/handlers/api-connectors.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { allConnectorTypes$ } from "../../../signals/zero-page/settings/connectors.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockConnectors(
  connectors: { type: ConnectorType; externalUsername?: string }[],
) {
  setMockConnectors(
    connectors.map((c) => {
      return {
        id: crypto.randomUUID(),
        type: c.type,
        authMethod: "oauth",
        externalId: null,
        externalUsername: c.externalUsername ?? null,
        externalEmail: null,
        oauthScopes: null,
        needsReconnect: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
    }),
  );
}

function manualGrantConnectorResponse(type: ConnectorType) {
  return {
    id: crypto.randomUUID(),
    type,
    authMethod: "api-token" as const,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    needsReconnect: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function mockAgentWithName(agentId: string, displayName: string) {
  setMockTeam([
    {
      id: agentId,
      displayName,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
}

function mockUserConnectors(enabledTypes: string[] = []) {
  server.use(
    mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes });
    }),
    mockApi(zeroUserConnectorsContract.update, ({ respond }) => {
      return respond(200, { enabledTypes });
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
  return { closed: true, close: vi.fn(), location: { href: "" } };
}

async function findTestOAuthDeviceConnectButton(): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", {
    name: "OAuth Device Authorization",
  });
  const section = heading.parentElement;
  if (!section) {
    throw new Error("OAuth Device Authorization section not found");
  }

  const button = queryAllByRoleFast("button", section).find((element) => {
    return (
      element.textContent?.trim() === "Connect Test OAuth Device (internal)"
    );
  });
  if (!button) {
    throw new Error("Test OAuth device connect button not found");
  }

  return button;
}

describe("directed connect page", () => {
  it("renders connect card for an oauth connector", async () => {
    detachedSetupPage({ context, path: "/connectors/gmail/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(CONNECTOR_TYPES.gmail.helpText),
    ).toBeInTheDocument();
    expect(screen.getByText("Connect")).toBeInTheDocument();
  });

  it("does not render an actionable card for feature-disabled connectors", async () => {
    const disabledConnectorType = "bentoml" satisfies ConnectorType;
    const disabledConnectorLabel = CONNECTOR_TYPES[disabledConnectorType].label;

    detachedSetupPage({
      context,
      path: `/connectors/${disabledConnectorType}/connect`,
    });

    const connectors = await context.store.get(allConnectorTypes$);
    expect(
      connectors.some((connector) => {
        return connector.type === disabledConnectorType;
      }),
    ).toBeFalsy();

    await waitFor(() => {
      expect(
        screen.queryByText(`Zero needs ${disabledConnectorLabel} to proceed`),
      ).not.toBeInTheDocument();
    });
  });

  it("shows connected state when connector is already connected", async () => {
    mockConnectors([{ type: "github" }]);

    detachedSetupPage({ context, path: "/connectors/github/connect" });

    await waitFor(() => {
      expect(screen.getByText("GitHub connected")).toBeInTheDocument();
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });

  it("shows Reconnect button alongside Connected pill when already connected", async () => {
    mockConnectors([{ type: "github" }]);

    detachedSetupPage({ context, path: "/connectors/github/connect" });

    await waitFor(() => {
      expect(screen.getByText("GitHub connected")).toBeInTheDocument();
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    const reconnectBtn = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Reconnect";
    });
    expect(reconnectBtn).toBeDefined();
  });
  it("reconnect button reopens OAuth flow for an already-connected OAuth connector", async () => {
    mockConnectorOauthStart();
    const mockWindow = createMockAuthWindow();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(mockWindow as unknown as Window);
    mockConnectors([{ type: "github" }]);

    detachedSetupPage({ context, path: "/connectors/github/connect" });

    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").find((el) => {
          return el.textContent?.trim() === "Reconnect";
        }),
      ).toBeDefined();
    });

    const reconnectBtn = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Reconnect";
    });
    expect(reconnectBtn).toBeDefined();
    click(reconnectBtn!);

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "about:blank",
        "_blank",
        expect.any(String),
      );
      expect(mockWindow.location.href).toBe(
        "https://oauth.test/github/authorize",
      );
    });
  });

  it("reconnect button opens manual grant dialog for an already-connected api-token connector", async () => {
    mockConnectors([{ type: "axiom" }]);

    detachedSetupPage({ context, path: "/connectors/axiom/connect" });

    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").find((el) => {
          return el.textContent?.trim() === "Reconnect";
        }),
      ).toBeDefined();
    });

    const reconnectBtn = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Reconnect";
    });
    expect(reconnectBtn).toBeDefined();
    click(reconnectBtn!);

    // api-token connectors route the reconnect click through the manual grant dialog
    // rather than an OAuth popup.
    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });
  });

  it("normalizes uppercase type in URL to match connector key", async () => {
    detachedSetupPage({ context, path: "/connectors/Gmail/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
  });

  it("renders nothing for an unknown connector type", async () => {
    detachedSetupPage({ context, path: "/connectors/nonexistent/connect" });

    // The card should not render — no heading, no button
    await waitFor(() => {
      expect(
        screen.queryByText(/Zero needs .* to proceed/),
      ).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });

  it("shows agent display name instead of 'Zero' when agent has a name", async () => {
    mockAgentWithName(AGENT_ID, "My Assistant");

    detachedSetupPage({
      context,
      path: `/connectors/gmail/connect?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("My Assistant needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
  });

  it("opens manual grant dialog for a connector without oauth", async () => {
    // Find a connector type that only has api-token auth
    const apiTokenOnlyType = CONNECTOR_TYPE_KEYS.find((type) => {
      const methods = CONNECTOR_TYPES[type].authMethods;
      return "api-token" in methods && !("oauth" in methods);
    });

    // Skip if no api-token-only connector exists
    if (!apiTokenOnlyType) {
      return;
    }

    const config = CONNECTOR_TYPES[apiTokenOnlyType];

    detachedSetupPage({
      context,
      path: `/connectors/${apiTokenOnlyType}/connect`,
    });

    await waitFor(() => {
      expect(
        screen.getByText(`Zero needs ${config.label} to proceed`),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Connect"));

    // Dialog should open with the connector label as title
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: config.label }),
      ).toBeInTheDocument();
    });
  });

  it("opens manual grant dialog by manual grant shape", async () => {
    const user = userEvent.setup();
    let submittedAuthMethod: string | undefined;
    let submittedValues: Record<string, string> | undefined;

    server.use(
      mockApi(zeroConnectorManualGrantContract.connect, ({ body, respond }) => {
        submittedAuthMethod = body.authMethod;
        submittedValues = body.values;
        return respond(200, manualGrantConnectorResponse("zendesk"));
      }),
    );

    detachedSetupPage({
      context,
      path: "/connectors/zendesk/connect",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Zendesk to proceed"),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Connect"));

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
      expect(submittedAuthMethod).toBe("api-token");
      expect(submittedValues).toStrictEqual({
        ZENDESK_API_TOKEN: "zendesk-token",
        ZENDESK_EMAIL: "support@example.com",
        ZENDESK_SUBDOMAIN: "example-subdomain",
      });
    });
  });

  it("opens the method picker when a directed connector has multiple manual grants", async () => {
    const authMethods: Partial<
      Record<ConnectorAuthMethodId, ConnectorAuthMethodConfig>
    > = CONNECTOR_TYPES.axiom.authMethods;
    const apiTokenMethod = authMethods["api-token"];
    if (!apiTokenMethod) {
      throw new Error("axiom connector must have an api-token auth method");
    }
    const originalApiMethod = authMethods.api;
    authMethods.api = {
      ...apiTokenMethod,
      label: "Secondary API Token",
    };

    try {
      detachedSetupPage({
        context,
        path: "/connectors/axiom/connect",
      });

      await waitFor(() => {
        expect(
          screen.getByText("Zero needs Axiom to proceed"),
        ).toBeInTheDocument();
      });

      click(screen.getByText("Connect"));

      await waitFor(() => {
        expect(screen.getByText("Secondary API Token")).toBeInTheDocument();
        expect(screen.getAllByText("Save")).toHaveLength(2);
      });
    } finally {
      if (originalApiMethod) {
        authMethods.api = originalApiMethod;
      } else {
        delete authMethods.api;
      }
    }
  });

  it("keeps directed manual grant save disabled for whitespace-only required values", async () => {
    const user = userEvent.setup();
    let requestCalled = false;

    server.use(
      mockApi(zeroConnectorManualGrantContract.connect, ({ respond }) => {
        requestCalled = true;
        return respond(200, manualGrantConnectorResponse("axiom"));
      }),
    );

    detachedSetupPage({
      context,
      path: "/connectors/axiom/connect",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Axiom to proceed"),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("xaat-..."), "   ");

    const saveButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent === "Save";
    });
    expect(saveButton).toBeDisabled();
    expect(requestCalled).toBeFalsy();
  });

  it("has a logo link that navigates to /connectors", async () => {
    detachedSetupPage({ context, path: "/connectors/gmail/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });

    const logoLink = screen.getByLabelText("VM0");
    expect(logoLink.closest("a")).toHaveAttribute("href", "/connectors");
  });

  it("shows error toast when manual grant submission fails (CONN-D-045)", async () => {
    const user = userEvent.setup();

    server.use(
      mockApi(zeroConnectorManualGrantContract.connect, ({ respond }) => {
        return respond(401, {
          error: { message: "Invalid manual grant", code: "UNAUTHORIZED" },
        });
      }),
    );

    detachedSetupPage({ context, path: "/connectors/axiom/connect" });

    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").find((el) => {
          return el.textContent?.trim() === "Connect";
        }),
      ).toBeDefined();
    });

    const connectBtn1 = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Connect";
    });
    expect(connectBtn1).toBeDefined();
    click(connectBtn1!);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("xaat-..."), "bad-token");
    const saveBtn1 = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn1).toBeDefined();
    click(saveBtn1!);

    await waitFor(() => {
      expect(screen.getByText("Invalid manual grant")).toBeInTheDocument();
    });
  });

  it("connect button opens OAuth flow for OAuth-enabled connector (CONN-I-047)", async () => {
    mockConnectorOauthStart();
    const mockWindow = createMockAuthWindow();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(mockWindow as unknown as Window);

    detachedSetupPage({ context, path: "/connectors/gmail/connect" });

    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").find((el) => {
          return el.textContent?.trim() === "Connect";
        }),
      ).toBeDefined();
    });

    const connectBtn2 = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Connect";
    });
    expect(connectBtn2).toBeDefined();
    click(connectBtn2!);

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "about:blank",
        "_blank",
        expect.any(String),
      );
      expect(mockWindow.location.href).toBe(
        "https://oauth.test/gmail/authorize",
      );
    });
  });

  it("opens the method picker when a connector has auth-code and manual grants", async () => {
    const openSpy = vi.spyOn(window, "open");

    detachedSetupPage({
      context,
      path: "/connectors/stripe/connect",
      featureSwitches: { [FeatureSwitchKey.StripeConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Stripe to proceed"),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Stripe" }),
      ).toBeInTheDocument();
      expect(screen.getByText("OAuth (Recommended)")).toBeInTheDocument();
      expect(screen.getAllByText("API Key").length).toBeGreaterThan(0);
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("opens device auth dialog before provider verification for device-auth OAuth connectors", async () => {
    const openSpy = vi.spyOn(window, "open");
    let startCalled = false;
    server.use(
      mockApi(zeroConnectorOauthStartContract.start, ({ respond }) => {
        startCalled = true;
        return respond(200, {
          authorizationUrl: "https://oauth.test/test-oauth-device/authorize",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/connectors/test-oauth-device/connect",
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Test OAuth Device (internal) to proceed"),
      ).toBeInTheDocument();
    });

    const connectButton = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Connect";
    });
    expect(connectButton).toBeDefined();
    click(connectButton!);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test OAuth Device (internal)" }),
      ).toBeInTheDocument();
    });
    const testOAuthDeviceConnectButton =
      await findTestOAuthDeviceConnectButton();
    expect(testOAuthDeviceConnectButton).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    expect(startCalled).toBeFalsy();
  });

  it("save button submits manual grant values to the server (CONN-I-049)", async () => {
    const user = userEvent.setup();
    let capturedAuthMethod: string | undefined;
    let capturedValues: Record<string, string> | undefined;

    server.use(
      mockApi(zeroConnectorManualGrantContract.connect, ({ body, respond }) => {
        capturedAuthMethod = body.authMethod;
        capturedValues = body.values;
        return respond(200, manualGrantConnectorResponse("axiom"));
      }),
    );

    detachedSetupPage({ context, path: "/connectors/axiom/connect" });

    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").find((el) => {
          return el.textContent?.trim() === "Connect";
        }),
      ).toBeDefined();
    });

    const connectBtn3 = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Connect";
    });
    expect(connectBtn3).toBeDefined();
    click(connectBtn3!);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(
      screen.getByPlaceholderText("xaat-..."),
      "test-token-value",
    );
    const saveBtn2 = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn2).toBeDefined();
    click(saveBtn2!);

    await waitFor(() => {
      expect(capturedAuthMethod).toBe("api-token");
      expect(capturedValues).toStrictEqual({
        AXIOM_TOKEN: "test-token-value",
      });
    });
  });

  it("auto-authorizes agent after manual grant connect when agentId is present", async () => {
    const user = userEvent.setup();
    mockUserConnectors();

    let authorizeCalled = false;
    server.use(
      mockApi(zeroConnectorManualGrantContract.connect, ({ respond }) => {
        return respond(200, manualGrantConnectorResponse("axiom"));
      }),
      mockApi(zeroUserConnectorsContract.update, ({ respond }) => {
        authorizeCalled = true;
        return respond(200, { enabledTypes: ["axiom"] });
      }),
    );

    detachedSetupPage({
      context,
      path: `/connectors/axiom/connect?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").find((el) => {
          return el.textContent?.trim() === "Connect";
        }),
      ).toBeDefined();
    });

    const connectBtn = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Connect";
    });
    expect(connectBtn).toBeDefined();
    click(connectBtn!);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(
      screen.getByPlaceholderText("xaat-..."),
      "test-token-value",
    );
    const saveBtn = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn).toBeDefined();
    click(saveBtn!);

    await waitFor(() => {
      expect(authorizeCalled).toBeTruthy();
    });
  });

  it("auto-authorizes agent after device auth connect when agentId is present", async () => {
    mockUserConnectors();
    setMockOauthDeviceAuthSessionPollResponses([
      {
        status: "complete",
        connector: {
          id: "00000000-0000-4000-8000-000000000201",
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

    let authorizeCalled = false;
    server.use(
      mockApi(zeroUserConnectorsContract.update, ({ respond }) => {
        authorizeCalled = true;
        return respond(200, { enabledTypes: ["test-oauth-device"] });
      }),
    );
    vi.spyOn(window, "open").mockReturnValue(
      createMockAuthWindow() as unknown as Window,
    );

    detachedSetupPage({
      context,
      path: `/connectors/test-oauth-device/connect?agentId=${AGENT_ID}`,
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Test OAuth Device (internal) to proceed"),
      ).toBeInTheDocument();
    });
    click(screen.getByText("Connect"));

    await userEvent.click(await findTestOAuthDeviceConnectButton());
    await userEvent.click(await screen.findByText("Open verification page"));

    await waitFor(() => {
      expect(authorizeCalled).toBeTruthy();
    });
  });

  it("shows Google security warning notice for a Google connector when not connected (CONN-D-060)", async () => {
    detachedSetupPage({ context, path: "/connectors/gmail/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Google will show a security warning/),
    ).toBeInTheDocument();
    expect(screen.getByText("Advanced")).toBeInTheDocument();
    expect(screen.getByText(/Go to vm0\.ai \(unsafe\)/)).toBeInTheDocument();
  });

  it("shows Google security warning notice for other Google connectors (CONN-D-061)", async () => {
    detachedSetupPage({ context, path: "/connectors/google-sheets/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Google Sheets to proceed"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Google will show a security warning/),
    ).toBeInTheDocument();
  });

  it("does not show Google security warning notice for non-Google auth-code connectors (CONN-D-062)", async () => {
    detachedSetupPage({ context, path: "/connectors/github/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs GitHub to proceed"),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/Google will show a security warning/),
    ).not.toBeInTheDocument();
  });

  it("does not show Google security warning notice when Google connector is already connected (CONN-D-063)", async () => {
    mockConnectors([{ type: "gmail" }]);

    detachedSetupPage({ context, path: "/connectors/gmail/connect" });

    await waitFor(() => {
      expect(screen.getByText("Gmail connected")).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/Google will show a security warning/),
    ).not.toBeInTheDocument();
  });

  it("does not call authorize after manual grant connect when agentId is absent", async () => {
    const user = userEvent.setup();

    let authorizeCalled = false;
    server.use(
      mockApi(zeroConnectorManualGrantContract.connect, ({ respond }) => {
        return respond(200, manualGrantConnectorResponse("axiom"));
      }),
      mockApi(zeroUserConnectorsContract.update, ({ respond }) => {
        authorizeCalled = true;
        return respond(200, { enabledTypes: [] });
      }),
    );

    detachedSetupPage({
      context,
      path: "/connectors/axiom/connect",
    });

    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").find((el) => {
          return el.textContent?.trim() === "Connect";
        }),
      ).toBeDefined();
    });

    const connectBtn = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Connect";
    });
    expect(connectBtn).toBeDefined();
    click(connectBtn!);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(
      screen.getByPlaceholderText("xaat-..."),
      "test-token-value",
    );
    const saveBtn = queryAllByRoleFast("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn).toBeDefined();
    click(saveBtn!);

    // Wait for the token to be submitted
    await waitFor(() => {
      expect(screen.getByText("Axiom connected")).toBeInTheDocument();
    });

    expect(authorizeCalled).toBeFalsy();
  });
});
