import {
  zeroConnectorOauthStartContract,
  zeroConnectorExternalCodeSessionContract,
  zeroConnectorOauthDeviceAuthSessionContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type {
  ConnectorAuthMethodId,
  ConnectorType,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { isoFromNowMs, mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const HOURS_MS = 60 * 60 * 1000;

function mockConnectorOauthStart(): void {
  context.mocks.api(
    zeroConnectorOauthStartContract.start,
    ({ params, respond }) => {
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.type}/authorize`,
      });
    },
  );
}

function createMockAuthWindow(): Window {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  return authWindow;
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function connectorCardByLabel(label: string): HTMLElement {
  const labelElement = screen
    .getAllByTestId("connector-card-label")
    .find((element) => {
      return element.textContent === label;
    });
  const card = labelElement?.closest(".zero-card");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`${label} connector card not found`);
  }
  return card;
}

function mockConnectors(
  connectors: {
    type: ConnectorType;
    authMethod?: ConnectorAuthMethodId;
    externalUsername?: string;
    connectionStatus?: ConnectorResponse["connectionStatus"];
    oauthScopes?: string[];
    tokenExpiresAt?: string | null;
  }[],
): void {
  context.mocks.data.connectors(
    connectors.map((connector) => {
      return {
        id: crypto.randomUUID(),
        type: connector.type,
        authMethod: connector.authMethod ?? "oauth",
        externalId: null,
        externalUsername: connector.externalUsername ?? null,
        externalEmail: null,
        oauthScopes: connector.oauthScopes ?? null,
        connectionStatus: connector.connectionStatus ?? "connected",
        tokenExpiresAt: connector.tokenExpiresAt ?? null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
    }),
  );
}

function customConnector(
  overrides: Partial<CustomConnectorResponse>,
): CustomConnectorResponse {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "acme-search",
    displayName: "Acme Search",
    prefixes: ["https://api.acme.test/v1/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
    hasSecret: false,
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

function mockCustomConnectorStory(): void {
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "admin",
  });

  let connectors: CustomConnectorResponse[] = [];

  context.mocks.api(zeroCustomConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors });
  });
  context.mocks.api(
    zeroCustomConnectorsContract.create,
    ({ body, respond }) => {
      const created = customConnector({
        displayName: body.displayName,
        prefixes: body.prefixes,
        headerName: body.headerName,
        headerTemplate: body.headerTemplate,
      });
      connectors = [...connectors, created];
      return respond(201, created);
    },
  );
  context.mocks.api(
    zeroCustomConnectorSecretContract.set,
    ({ params, respond }) => {
      connectors = connectors.map((connector) => {
        return connector.id === params.id
          ? { ...connector, hasSecret: true }
          : connector;
      });
      return respond(204);
    },
  );
  context.mocks.api(
    zeroCustomConnectorSecretContract.delete,
    ({ params, respond }) => {
      connectors = connectors.map((connector) => {
        return connector.id === params.id
          ? { ...connector, hasSecret: false }
          : connector;
      });
      return respond(204);
    },
  );
  context.mocks.api(
    zeroCustomConnectorByIdContract.patch,
    ({ params, body, respond }) => {
      let renamed = connectors.find((connector) => {
        return connector.id === params.id;
      });
      connectors = connectors.map((connector) => {
        if (connector.id !== params.id) {
          return connector;
        }
        renamed = { ...connector, displayName: body.displayName };
        return renamed;
      });
      return respond(200, renamed ?? customConnector({}));
    },
  );
  context.mocks.api(
    zeroCustomConnectorByIdContract.delete,
    ({ params, respond }) => {
      connectors = connectors.filter((connector) => {
        return connector.id !== params.id;
      });
      return respond(204);
    },
  );
}

describe("connectors page", () => {
  it("shows connected and expiring connector statuses", async () => {
    mockNow();
    mockConnectors([
      { type: "github", externalUsername: "octocat" },
      {
        type: "openai",
        authMethod: "api-token",
        tokenExpiresAt: isoFromNowMs(26 * HOURS_MS),
      },
      {
        type: "deepseek",
        authMethod: "api-token",
        tokenExpiresAt: isoFromNowMs(30 * 60 * 1000),
      },
      {
        type: "axiom",
        authMethod: "api-token",
        tokenExpiresAt: isoFromNowMs(-HOURS_MS),
      },
      {
        type: "base44",
        authMethod: "oauth",
        tokenExpiresAt: isoFromNowMs(-HOURS_MS),
      },
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(
      within(connectorCardByLabel("OpenAI")).getByText("Expires in 2 days"),
    ).toBeInTheDocument();
    expect(
      within(connectorCardByLabel("DeepSeek")).getByText(
        "Expires in less than 1 hour",
      ),
    ).toBeInTheDocument();
    expect(
      within(connectorCardByLabel("Base44")).queryByText("Connection expired"),
    ).not.toBeInTheDocument();
    expect(
      within(connectorCardByLabel("Base44")).queryByText("Reconnect"),
    ).not.toBeInTheDocument();
    const expiredAxiomCard = connectorCardByLabel("Axiom");
    expect(
      within(expiredAxiomCard).getByText("Connection expired"),
    ).toBeInTheDocument();
    expect(within(expiredAxiomCard).getByText("Reconnect")).toBeInTheDocument();

    click(within(expiredAxiomCard).getByText("Reconnect"));

    const reconnectDialog = await screen.findByRole("dialog", {
      name: "Axiom",
    });
    expect(
      within(reconnectDialog).getByText("Connection expired"),
    ).toBeInTheDocument();
  });

  it("lets users browse connectors by grouped categories", async () => {
    mockConnectors([{ type: "github", externalUsername: "octocat" }]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-category-engineering-team-execution"),
      ).toBeInTheDocument();
    });

    const engineeringSection = screen.getByTestId(
      "connector-category-engineering-team-execution",
    );
    const engineeringLabels = within(engineeringSection)
      .getAllByTestId("connector-card-label")
      .map((element) => {
        return element.textContent;
      });
    expect(engineeringLabels[0]).toBe("GitHub");
    expect(engineeringLabels).toContain("Asana");

    const aiGroup = screen.getByTestId("connector-category-ai");
    const engineeringGroup = screen.getByTestId(
      "connector-category-engineering-team-execution",
    );
    expect(
      aiGroup.compareDocumentPosition(engineeringGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("navigates connector categories and opens a connector from the keyboard", async () => {
    mockConnectors([]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-category-menu-ai"),
      ).toBeInTheDocument();
    });

    click(screen.getByTestId("connector-category-menu-ai"));
    click(screen.getByTestId("connector-category-menu-ai-general-models"));
    click(
      screen.getByTestId("connector-category-menu-engineering-team-execution"),
    );

    const axiomCard = await screen.findByLabelText("Connect Axiom");
    fireEvent.keyDown(axiomCard, { key: " ", code: "Space" });

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Axiom" })).toBeInTheDocument();
      expect(screen.getByText("Save")).toBeInTheDocument();
    });
  });

  it("filters connectors by integration keywords", async () => {
    mockConnectors([{ type: "github", externalUsername: "octocat" }]);

    detachedSetupPage({ context, path: "/connectors" });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "vcs");

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(screen.queryByText("Slack")).not.toBeInTheDocument();
  });

  it("filters connectors by capability keywords", async () => {
    mockConnectors([
      { type: "github", externalUsername: "octocat" },
      {
        type: "axiom",
        authMethod: "api-token",
        tokenExpiresAt: isoFromNowMs(-HOURS_MS),
      },
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "logs");

    await waitFor(() => {
      expect(screen.getByText("Axiom")).toBeInTheDocument();
    });
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  });

  it("shows an empty state when connector search has no matches", async () => {
    mockConnectors([]);

    detachedSetupPage({ context, path: "/connectors" });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "nonexistent-connector-xyz");

    await waitFor(() => {
      expect(screen.getByText(/No connectors matching/)).toBeInTheDocument();
    });
  });

  it("keeps a reconnecting connector visibly pending until the OAuth update arrives", async () => {
    mockConnectors([
      {
        type: "github",
        connectionStatus: "reconnect-required",
        oauthScopes: ["repo", "project", "workflow"],
      },
    ]);
    mockConnectorOauthStart();
    context.mocks.browser.open(createMockAuthWindow());

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Reconnect")).toBeInTheDocument();
    });

    context.mocks.api(zeroConnectorsMainContract.list, ({ never }) => {
      return never();
    });

    click(screen.getByText("Reconnect"));

    await waitFor(() => {
      expect(
        screen.getAllByText((_, element) => {
          return element?.textContent?.includes("Connecting") ?? false;
        }).length,
      ).toBeGreaterThan(0);
    });
  });

  it("opens manual token connector setup", async () => {
    mockConnectors([]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Axiom")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Connect Axiom"));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Save")).toBeInTheDocument();
    });
  });

  it("shows Google connector approval guidance", async () => {
    mockConnectors([]);
    mockConnectorOauthStart();
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Gmail")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Connect Gmail"));
    await waitFor(() => {
      expect(
        screen.getByText(/Google will show a security warning/),
      ).toBeInTheDocument();
      expect(screen.getByText(/Go to vm0\.ai \(unsafe\)/)).toBeInTheDocument();
    });

    const gmailDialog = screen.getByRole("dialog", { name: "Gmail" });
    click(buttonByText("Connect", gmailDialog));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/gmail/authorize",
      );
      expect(
        within(gmailDialog).getByText("Connecting..."),
      ).toBeInTheDocument();
    });
  });

  it("shows Meta Ads review guidance before OAuth", async () => {
    mockConnectors([]);
    mockConnectorOauthStart();
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.MetaAdsConnector]: true },
    });

    await fill(await screen.findByPlaceholderText("Find connectors"), "meta");
    click(await screen.findByLabelText("Connect Meta Ads"));

    const metaAdsDialog = await screen.findByRole("dialog", {
      name: "Meta Ads",
    });
    await waitFor(() => {
      expect(
        within(metaAdsDialog).getByText(/Meta Ads is currently in Meta/),
      ).toBeInTheDocument();
      expect(
        within(metaAdsDialog).getByText(
          /We only request the permissions needed for ads workflows/,
        ),
      ).toBeInTheDocument();
    });

    click(buttonByText("Connect", metaAdsDialog));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/meta-ads/authorize",
      );
    });
  });

  it("opens OAuth scope review changes", async () => {
    mockConnectors([{ type: "github", oauthScopes: [] }]);
    mockConnectorOauthStart();
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    context.mocks.api(
      zeroConnectorScopeDiffContract.getScopeDiff,
      ({ respond }) => {
        return respond(200, {
          addedScopes: ["repo", "project"],
          removedScopes: [],
          currentScopes: [],
          storedScopes: ["repo", "project"],
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Review")).toBeInTheDocument();
    });

    click(screen.getByText("Review"));
    await waitFor(() => {
      expect(screen.getByText("repo")).toBeInTheDocument();
      expect(screen.getByText("project")).toBeInTheDocument();
    });

    const reviewDialog = screen.getByRole("dialog", {
      name: "GitHub — Permissions Update",
    });
    click(within(reviewDialog).getByText("Reconnect"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/github/authorize",
      );
      expect(
        screen.getAllByText((_, element) => {
          return element?.textContent?.includes("Connecting") ?? false;
        }).length,
      ).toBeGreaterThan(0);
    });
  });

  it("shows removed OAuth scopes during connector permission review", async () => {
    mockConnectors([
      {
        type: "github",
        oauthScopes: ["repo", "workflow"],
      },
    ]);
    context.mocks.api(
      zeroConnectorScopeDiffContract.getScopeDiff,
      ({ respond }) => {
        return respond(200, {
          addedScopes: [],
          removedScopes: ["workflow"],
          currentScopes: ["repo"],
          storedScopes: ["repo", "workflow"],
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Review")).toBeInTheDocument();
    });

    click(screen.getByText("Review"));
    await waitFor(() => {
      expect(screen.getByText("Removed permissions")).toBeInTheDocument();
      expect(screen.getByText("workflow")).toBeInTheDocument();
    });
  });

  it("keeps external-code connector setup open when the sign-in session cannot start", async () => {
    mockConnectors([]);
    context.mocks.api(
      zeroConnectorExternalCodeSessionContract.create,
      ({ respond }) => {
        return respond(500, {
          error: {
            message: "AWS sign-in is temporarily unavailable",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.AwsConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Find connectors"),
      ).toBeInTheDocument();
    });

    await fill(screen.getByPlaceholderText("Find connectors"), "aws");
    click(await screen.findByLabelText("Connect AWS"));

    const connectDialog = await screen.findByRole("dialog", { name: "AWS" });
    click(buttonByText("Start AWS sign-in", connectDialog));

    await waitFor(() => {
      expect(
        within(connectDialog).getByText(
          "AWS sign-in is temporarily unavailable",
        ),
      ).toBeInTheDocument();
      expect(
        buttonByText("Start AWS sign-in", connectDialog),
      ).toBeInTheDocument();
    });
  });

  it("keeps the external-code form open when the authorization code is rejected", async () => {
    mockConnectors([]);
    context.mocks.browser.open(createMockAuthWindow());
    context.mocks.api(
      zeroConnectorExternalCodeSessionContract.complete,
      ({ respond }) => {
        return respond(400, {
          error: {
            message: "Authorization code rejected",
            code: "BAD_REQUEST",
          },
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.AwsConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Find connectors"),
      ).toBeInTheDocument();
    });

    await fill(screen.getByPlaceholderText("Find connectors"), "aws");
    click(await screen.findByLabelText("Connect AWS"));

    const connectDialog = await screen.findByRole("dialog", { name: "AWS" });
    click(buttonByText("Start AWS sign-in", connectDialog));
    await waitFor(() => {
      expect(
        buttonByText("Open AWS sign-in", connectDialog),
      ).toBeInTheDocument();
    });

    click(buttonByText("Open AWS sign-in", connectDialog));
    await fill(
      within(connectDialog).getByTestId("connector-external-code-input"),
      "BAD-CODE",
    );
    click(
      within(connectDialog).getByTestId("connector-external-code-complete"),
    );

    await waitFor(() => {
      expect(
        within(connectDialog).getByText("Authorization code rejected"),
      ).toBeInTheDocument();
      expect(
        within(connectDialog).getByTestId("connector-external-code-input"),
      ).toHaveValue("BAD-CODE");
    });
  });

  it("expires an external-code connector grant before completion and leaves retry available", async () => {
    mockConnectors([]);
    context.mocks.browser.open(createMockAuthWindow());
    context.mocks.api(
      zeroConnectorExternalCodeSessionContract.create,
      ({ params, respond }) => {
        return respond(200, {
          sessionId: "00000000-0000-4000-8000-000000000055",
          sessionToken: "mock-expiring-external-code-token",
          type: params.type,
          status: "pending",
          authorizationUrl: "https://oauth.test/aws/external-code",
          expiresIn: 0,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.AwsConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Find connectors"),
      ).toBeInTheDocument();
    });

    await fill(screen.getByPlaceholderText("Find connectors"), "aws");
    click(await screen.findByLabelText("Connect AWS"));

    const connectDialog = await screen.findByRole("dialog", { name: "AWS" });
    click(buttonByText("Start AWS sign-in", connectDialog));
    await waitFor(() => {
      expect(
        buttonByText("Open AWS sign-in", connectDialog),
      ).toBeInTheDocument();
    });

    click(buttonByText("Open AWS sign-in", connectDialog));
    await fill(
      within(connectDialog).getByTestId("connector-external-code-input"),
      "EXPIRED-CODE",
    );
    click(
      within(connectDialog).getByTestId("connector-external-code-complete"),
    );

    await waitFor(() => {
      expect(
        within(connectDialog).getByText(
          "Connection session expired. Start again to retry.",
        ),
      ).toBeInTheDocument();
      expect(
        buttonByText("Start AWS sign-in", connectDialog),
      ).toBeInTheDocument();
    });
  });

  it("starts a device-auth connector grant", async () => {
    mockConnectors([]);

    context.mocks.browser.open(createMockAuthWindow());
    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Base44")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Connect Base44"));

    const deviceDialog = await screen.findByRole("dialog", { name: "Base44" });
    click(buttonByText("Connect Base44", deviceDialog));

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-oauth-device-code"),
      ).toHaveTextContent("VM0-DEVICE");
    });
    click(screen.getByTestId("connector-oauth-device-open"));
  });

  it("starts Stripe device authorization with the default mode", async () => {
    mockConnectors([]);
    let capturedStartBody: unknown = null;
    context.mocks.api(
      zeroConnectorOauthDeviceAuthSessionContract.create,
      ({ body, params, respond }) => {
        capturedStartBody = body;
        return respond(200, {
          sessionId: "00000000-0000-4000-8000-000000000123",
          sessionToken: "mock-stripe-device-session-token",
          type: params.type,
          status: "pending",
          userCode: "STRIPE-DEVICE",
          verificationUri: "https://oauth.test/stripe/device",
          verificationUriComplete:
            "https://oauth.test/stripe/device?user_code=STRIPE-DEVICE",
          expiresIn: 300,
          interval: 1,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.StripeConnector]: true },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Stripe")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Connect Stripe"));

    const stripeDialog = await screen.findByRole("dialog", { name: "Stripe" });
    expect(
      within(stripeDialog).getByText("Sign in with Stripe"),
    ).toBeInTheDocument();
    expect(within(stripeDialog).getByText("Mode")).toBeInTheDocument();
    expect(within(stripeDialog).getByText("Test")).toBeInTheDocument();

    click(buttonByText("Connect Stripe", stripeDialog));

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-oauth-device-code"),
      ).toHaveTextContent("STRIPE-DEVICE");
      expect(capturedStartBody).toMatchObject({
        authMethod: "cli",
        options: { mode: "test" },
      });
    });
  });

  it("starts Stripe device authorization with live mode", async () => {
    mockConnectors([]);
    let capturedStartBody: unknown = null;
    context.mocks.api(
      zeroConnectorOauthDeviceAuthSessionContract.create,
      ({ body, params, respond }) => {
        capturedStartBody = body;
        return respond(200, {
          sessionId: "00000000-0000-4000-8000-000000000124",
          sessionToken: "mock-stripe-live-device-session-token",
          type: params.type,
          status: "pending",
          userCode: "STRIPE-LIVE",
          verificationUri: "https://oauth.test/stripe/device",
          verificationUriComplete:
            "https://oauth.test/stripe/device?user_code=STRIPE-LIVE",
          expiresIn: 300,
          interval: 1,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.StripeConnector]: true },
    });

    click(await screen.findByLabelText("Connect Stripe"));

    const stripeDialog = await screen.findByRole("dialog", { name: "Stripe" });
    click(within(stripeDialog).getByText("Test"));
    click(await screen.findByText("Live"));
    click(buttonByText("Connect Stripe", stripeDialog));

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-oauth-device-code"),
      ).toHaveTextContent("STRIPE-LIVE");
      expect(capturedStartBody).toMatchObject({
        authMethod: "cli",
        options: { mode: "live" },
      });
    });
  });

  it("shows a retryable error when a device-auth verification page is blocked", async () => {
    mockConnectors([]);
    context.mocks.browser.open(null);
    context.mocks.api(
      zeroConnectorOauthDeviceAuthSessionContract.create,
      ({ params, respond }) => {
        return respond(200, {
          sessionId: "00000000-0000-4000-8000-000000000003",
          sessionToken: `mock-${params.type}-blocked-device-token`,
          type: params.type,
          status: "pending",
          userCode: "NO-COMPLETE",
          verificationUri: `https://oauth.test/${params.type}/device`,
          expiresIn: 300,
          interval: 1,
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Base44")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Connect Base44"));

    const deviceDialog = await screen.findByRole("dialog", { name: "Base44" });
    click(buttonByText("Connect Base44", deviceDialog));

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-oauth-device-code"),
      ).toHaveTextContent("NO-COMPLETE");
    });
    click(screen.getByTestId("connector-oauth-device-open"));

    await waitFor(() => {
      expect(
        within(deviceDialog).getByText(
          "Could not open the verification page. Try again.",
        ),
      ).toBeInTheDocument();
      expect(
        within(deviceDialog).getByText(
          "Copy this code, then open the verification page to approve access.",
        ),
      ).toBeInTheDocument();
    });
  });

  it("completes a device-auth connector grant", async () => {
    mockConnectors([]);

    context.mocks.browser.open(createMockAuthWindow());
    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Base44")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Connect Base44"));

    const deviceDialog = await screen.findByRole("dialog", { name: "Base44" });
    click(buttonByText("Connect Base44", deviceDialog));

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-oauth-device-code"),
      ).toHaveTextContent("VM0-DEVICE");
    });
    click(screen.getByTestId("connector-oauth-device-open"));

    await waitFor(() => {
      expect(
        within(connectorCardByLabel("Base44")).getByText("Connected"),
      ).toBeInTheDocument();
    });
  });

  it("shows device-auth connector start failures and leaves retry available", async () => {
    mockConnectors([]);
    context.mocks.api(
      zeroConnectorOauthDeviceAuthSessionContract.create,
      ({ respond }) => {
        return respond(500, {
          error: {
            message: "Base44 device authorization is unavailable",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Base44")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Connect Base44"));

    const deviceDialog = await screen.findByRole("dialog", { name: "Base44" });
    click(buttonByText("Connect Base44", deviceDialog));

    await waitFor(() => {
      expect(
        within(deviceDialog).getByText(
          "Base44 device authorization is unavailable",
        ),
      ).toBeInTheDocument();
      expect(buttonByText("Try again", deviceDialog)).toBeInTheDocument();
    });
  });

  it("shows denied device-auth connector grants and allows a retry", async () => {
    mockConnectors([]);
    context.mocks.browser.open(createMockAuthWindow());
    context.mocks.api(
      zeroConnectorOauthDeviceAuthSessionContract.poll,
      ({ respond }) => {
        return respond(200, {
          status: "denied",
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Base44")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Connect Base44"));

    const deviceDialog = await screen.findByRole("dialog", { name: "Base44" });
    click(buttonByText("Connect Base44", deviceDialog));

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-oauth-device-code"),
      ).toHaveTextContent("VM0-DEVICE");
    });
    click(screen.getByTestId("connector-oauth-device-open"));

    await waitFor(() => {
      expect(
        within(deviceDialog).getByText(
          "Connection was denied. Start again to retry.",
        ),
      ).toBeInTheDocument();
      expect(buttonByText("Try again", deviceDialog)).toBeInTheDocument();
    });
  });

  it("expires a pending device-auth connector grant and leaves retry available", async () => {
    mockConnectors([]);
    context.mocks.browser.open(createMockAuthWindow());
    context.mocks.api(
      zeroConnectorOauthDeviceAuthSessionContract.create,
      ({ params, respond }) => {
        return respond(200, {
          sessionId: "00000000-0000-4000-8000-000000000044",
          sessionToken: "mock-expiring-device-token",
          type: params.type,
          status: "pending",
          userCode: "EXPIRE-ME",
          verificationUri: `https://oauth.test/${params.type}/device`,
          verificationUriComplete: `https://oauth.test/${params.type}/device?user_code=EXPIRE-ME`,
          expiresIn: 0.2,
          interval: 0,
        });
      },
    );
    context.mocks.api(
      zeroConnectorOauthDeviceAuthSessionContract.poll,
      ({ respond }) => {
        return respond(200, {
          status: "pending",
          interval: 0,
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Base44")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Connect Base44"));

    const deviceDialog = await screen.findByRole("dialog", { name: "Base44" });
    click(buttonByText("Connect Base44", deviceDialog));

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-oauth-device-code"),
      ).toHaveTextContent("EXPIRE-ME");
    });
    click(screen.getByTestId("connector-oauth-device-open"));

    await waitFor(() => {
      expect(
        within(deviceDialog).getByText(
          "Connection session expired. Start again to retry.",
        ),
      ).toBeInTheDocument();
      expect(buttonByText("Try again", deviceDialog)).toBeInTheDocument();
    });
  });

  it("connects a manual token connector", async () => {
    mockConnectors([]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Axiom")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Connect Axiom"));

    const axiomDialog = await screen.findByRole("dialog", { name: "Axiom" });
    await fill(
      within(axiomDialog).getByPlaceholderText("xaat-..."),
      "xaat-test",
    );
    click(buttonByText("Save", axiomDialog));

    await waitFor(() => {
      expect(
        within(connectorCardByLabel("Axiom")).getByText("Connected"),
      ).toBeInTheDocument();
    });

    click(within(connectorCardByLabel("Axiom")).getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Axiom")).toBeInTheDocument();
      expect(
        within(connectorCardByLabel("Axiom")).queryByText("Connected"),
      ).not.toBeInTheDocument();
    });
  });

  it("disconnects a connected manual token connector", async () => {
    mockConnectors([{ type: "axiom", authMethod: "api-token" }]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        within(connectorCardByLabel("Axiom")).getByText("Connected"),
      ).toBeInTheDocument();
    });

    click(within(connectorCardByLabel("Axiom")).getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Axiom")).toBeInTheDocument();
      expect(
        within(connectorCardByLabel("Axiom")).queryByText("Connected"),
      ).not.toBeInTheDocument();
    });
  });

  it("connects AWS with an authorization code and authorizes an agent", async () => {
    mockConnectors([]);
    context.mocks.data.team([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        ownerId: "test-user-123",
        displayName: "Research Agent",
        description: null,
        sound: null,
        avatarUrl: null,
        customSkills: [],
        visibility: "public",
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    context.mocks.browser.open(createMockAuthWindow());

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.AwsConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Find connectors"),
      ).toBeInTheDocument();
    });

    await fill(screen.getByPlaceholderText("Find connectors"), "aws");
    click(await screen.findByLabelText("Connect AWS"));

    const connectDialog = await screen.findByRole("dialog", { name: "AWS" });
    expect(
      within(connectDialog).getByText(
        /temporary AWS connector expires after up to 12 hours/,
      ),
    ).toBeInTheDocument();

    click(buttonByText("Start AWS sign-in", connectDialog));

    await waitFor(() => {
      expect(
        buttonByText("Open AWS sign-in", connectDialog),
      ).toBeInTheDocument();
    });

    click(buttonByText("Open AWS sign-in", connectDialog));
    await fill(
      within(connectDialog).getByTestId("connector-external-code-input"),
      "AWS-CODE",
    );
    click(
      within(connectDialog).getByTestId("connector-external-code-complete"),
    );

    await waitFor(() => {
      expect(
        screen.getByText("You've successfully connected with AWS!"),
      ).toBeInTheDocument();
    });

    click(buttonByText("Research Agent"));
    click(buttonByText("Confirm"));

    await waitFor(() => {
      expect(screen.getByText("AWS enabled for 1 agent")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        within(connectorCardByLabel("AWS")).getByText(
          /@arn:aws:iam::000000000000:user\/mock-aws/u,
        ),
      ).toBeInTheDocument();
    });
  });

  it("reports a failed connector disconnect", async () => {
    mockConnectors([{ type: "github", externalUsername: "octocat" }]);
    context.mocks.api(zeroConnectorsByTypeContract.delete, ({ respond }) => {
      return respond(404, {
        error: { message: "Failed to disconnect", code: "NOT_FOUND" },
      });
    });

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });
    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(screen.getByText("Failed to disconnect")).toBeInTheDocument();
    });
  });

  it("manages a custom connector from creation through deletion", async () => {
    mockCustomConnectorStory();

    detachedSetupPage({ context, path: "/connectors" });

    click(await screen.findByText("Custom"));

    await waitFor(() => {
      expect(screen.getByText("New connector")).toBeInTheDocument();
      expect(
        screen.getByText(
          "No custom connectors yet. Create one to register an API for every member to use.",
        ),
      ).toBeInTheDocument();
    });

    click(screen.getByText("New connector"));

    const createDialog = await screen.findByRole("dialog");
    await fill(within(createDialog).getByLabelText("Display name"), "Acme API");
    await fill(
      within(createDialog).getByLabelText(/Prefixes/u),
      "https://api.acme.test/v1/",
    );
    click(buttonByText("Create", createDialog));

    await waitFor(() => {
      expect(screen.getByText("Acme API")).toBeInTheDocument();
      expect(screen.getByText("https://api.acme.test/v1/")).toBeInTheDocument();
    });

    click(screen.getByText("Connect"));

    const connectDialog = await screen.findByRole("dialog");
    expect(
      within(connectDialog).getByText("Connect Acme API"),
    ).toBeInTheDocument();
    await fill(within(connectDialog).getByLabelText("Secret"), "acme-secret");
    click(buttonByText("Save", connectDialog));

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Rename"));

    const renameDialog = await screen.findByRole("dialog");
    await fill(
      within(renameDialog).getByLabelText("Display name"),
      "Acme Billing API",
    );
    click(buttonByText("Save", renameDialog));

    await waitFor(() => {
      expect(screen.getByText("Acme Billing API")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(screen.getByText("Connect")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Delete"));

    const deleteDialog = await screen.findByRole("dialog");
    expect(
      within(deleteDialog).getByText("Delete Acme Billing API?"),
    ).toBeInTheDocument();
    click(buttonByText("Delete", deleteDialog));

    await waitFor(() => {
      expect(
        screen.getByText(
          "No custom connectors yet. Create one to register an API for every member to use.",
        ),
      ).toBeInTheDocument();
    });
  });
});
