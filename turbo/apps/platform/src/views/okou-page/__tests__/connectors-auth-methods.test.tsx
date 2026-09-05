import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import {
  connectorExternalCodeSessionContract,
  connectorManualGrantContract,
  connectorNoAuthGrantContract,
  connectorOauthDeviceAuthSessionContract,
  connectorOauthStartContract,
  connectorOpenIdStartContract,
  connectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  getConnectorCard,
  getConnectorIcon,
  listAgent,
  mockConnectors,
  mockPublicConnectorStatus,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();

function createAuthWindow(): Window {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    configurable: true,
    value: { href: "" },
  });
  return authWindow;
}

function createReusableAuthWindow(): {
  readonly authWindow: Window;
  readonly reopen: () => void;
} {
  const authWindow = createAuthWindow();
  let closed = false;
  Object.defineProperty(authWindow, "closed", {
    configurable: true,
    get: () => {
      return closed;
    },
  });
  Object.defineProperty(authWindow, "close", {
    configurable: true,
    value: () => {
      closed = true;
    },
  });
  return {
    authWindow,
    reopen: () => {
      closed = false;
    },
  };
}

function storeConnectedConnector(
  slug: ConnectorSlug,
  authMethod: string,
  externalUsername: string | null = null,
): ConnectorResponse {
  const connector = {
    id: crypto.randomUUID(),
    slug,
    authMethod,
    externalId: null,
    externalUsername,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } satisfies ConnectorResponse;
  context.mocks.data.connectors([connector]);
  return connector;
}

function mockAgentConnectorAccess(connectorSlug: ConnectorSlug): void {
  const authorizedAgentIds = new Set<string>();
  context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
    return respond(200, {
      enabledConnectorSlugs: authorizedAgentIds.has(params.id)
        ? [connectorSlug]
        : [],
    });
  });
  context.mocks.api(
    userConnectorsContract.update,
    ({ params, body, respond }) => {
      if (body.enabledConnectorSlugs.includes(connectorSlug)) {
        if (body.operation === "add") {
          authorizedAgentIds.add(params.id);
        } else {
          authorizedAgentIds.delete(params.id);
        }
      }
      return respond(200, {
        enabledConnectorSlugs: authorizedAgentIds.has(params.id)
          ? [connectorSlug]
          : [],
      });
    },
  );
}

function oauthMethod(label = "OAuth") {
  return {
    id: "oauth",
    label,
    description: null,
    grantKind: "auth-code" as const,
    manualFields: [],
    startOptions: [],
  };
}

function noAuthMethod() {
  return {
    id: "api",
    label: "Public catalog",
    description: "Enable public catalog data.",
    grantKind: "none" as const,
    manualFields: [],
    startOptions: [],
  };
}

function manualMethod(args: {
  readonly id: string;
  readonly label: string;
  readonly fieldId: string;
  readonly fieldLabel: string;
  readonly placeholder: string;
}) {
  return {
    id: args.id,
    label: args.label,
    description: null,
    grantKind: "manual" as const,
    manualFields: [
      {
        id: args.fieldId,
        label: args.fieldLabel,
        required: true,
        placeholder: args.placeholder,
        inputType: "password" as const,
      },
    ],
    startOptions: [],
  };
}

async function openAwsWithCode(code: string): Promise<{
  readonly dialog: HTMLElement;
  readonly complete: HTMLElement;
}> {
  mockConnectors(context, []);
  context.mocks.browser.open(createAuthWindow());
  await setupPage({ context, path: "/connectors" });
  await fill(await screen.findByPlaceholderText("Find connectors"), "aws");
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect AWS");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "AWS" });
  click(getConnectorAction("button", "Start AWS sign-in", dialog));
  await fill(
    await within(dialog).findByTestId("connector-external-code-input"),
    code,
  );
  return {
    dialog,
    complete: within(dialog).getByTestId("connector-external-code-complete"),
  };
}

test("Add an AWS account with an external code", async () => {
  mockConnectors(context, []);
  context.mocks.data.agents([
    listAgent("c0000000-0000-4000-a000-000000000002", "Research Agent"),
  ]);
  context.mocks.api(userConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: [] });
  });
  const authWindow = createAuthWindow();
  const browserOpen = context.mocks.browser.open(authWindow);
  context.mocks.api(
    connectorExternalCodeSessionContract.create,
    ({ body, params, respond }) => {
      expect(params.connectorSlug).toBe("aws");
      expect(body.account).toStrictEqual({ intent: "add" });
      return respond(200, {
        sessionId: "00000000-0000-4000-8000-000000000002",
        sessionToken: "mock-aws-external-code-session-token",
        connectorSlug: "aws",
        status: "pending",
        authorizationUrl: "https://oauth.test/aws/external-code",
        expiresIn: 600,
      });
    },
  );
  await setupPage({
    context,
    path: "/connectors",
  });
  await fill(await screen.findByPlaceholderText("Find connectors"), "aws");
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect AWS");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "AWS" });
  expect(dialog).toHaveTextContent(
    /temporary AWS connector expires after up to 12 hours/u,
  );

  click(getConnectorAction("button", "Start AWS sign-in", dialog));
  await expect(
    waitFor(() => {
      return getConnectorAction("button", "Open AWS sign-in", dialog);
    }),
  ).resolves.toBeInTheDocument();
  click(getConnectorAction("button", "Open AWS sign-in", dialog));
  expect(
    browserOpen.calls.some((call) => {
      return call.url === "https://oauth.test/aws/external-code";
    }),
  ).toBeTruthy();
  await fill(
    within(dialog).getByTestId("connector-external-code-input"),
    "AWS-CODE",
  );
  click(within(dialog).getByTestId("connector-external-code-complete"));

  await expect(screen.findByText("AWS connected")).resolves.toBeInTheDocument();
  const naming = await screen.findByRole("dialog", {
    name: "Name your AWS account",
  });
  click(getConnectorAction("button", "Skip", naming));

  const awsCard = getConnectorCard("AWS");
  await expect(
    within(awsCard).findByText("arn:aws:iam::000000000000:user/mock-aws"),
  ).resolves.toBeInTheDocument();
  expect(
    getConnectorAction("button", "Manage AWS access", awsCard),
  ).toHaveTextContent("Add access");
  expect(
    screen.queryByText("You've successfully connected with AWS!"),
  ).toBeNull();
});

test("Add an account through OpenID", async () => {
  const slug = "server-authored-steam";
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: slug,
      label: "Partner Steam",
      icon: {
        url: "https://icons.example.test/partner-steam.svg",
        invertInDarkMode: false,
      },
      authMethods: [
        {
          id: "partner-openid",
          label: "Partner OpenID",
          description: null,
          grantKind: "openid-auth",
          manualFields: [],
          startOptions: [],
        },
      ],
    }),
  ]);
  const authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  context.mocks.api(connectorOpenIdStartContract.start, ({ body, respond }) => {
    expect(body).toMatchObject({
      account: { intent: "add" },
      authMethod: "partner-openid",
    });
    return respond(200, {
      authorizationUrl: "https://openid.test/partner-steam/authorize",
    });
  });
  await setupPage({
    context,
    path: "/connectors?keywords=partner+steam",
  });

  await expect(screen.findByText("Partner Steam")).resolves.toBeInTheDocument();
  expect(getConnectorIcon("Partner Steam")).toHaveAttribute(
    "src",
    "https://icons.example.test/partner-steam.svg",
  );
  click(getConnectorAction("button", "Connect Partner Steam"));

  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://openid.test/partner-steam/authorize",
    );
  });
});

test("Choose a credential-free method among multiple connection methods", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Public Stripe",
      authMethods: [oauthMethod("Public OAuth"), noAuthMethod()],
    }),
  ]);
  let selectedMethod: string | null = null;
  context.mocks.api(
    connectorNoAuthGrantContract.connect,
    ({ body, respond }) => {
      selectedMethod = body.authMethod;
      return respond(200, storeConnectedConnector("stripe", body.authMethod));
    },
  );
  await setupPage({
    context,
    path: "/connectors?keywords=public+stripe",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Stripe");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Public Stripe" });
  expect(within(dialog).getByText("Public OAuth")).toBeInTheDocument();
  expect(within(dialog).getByText("Public catalog")).toBeInTheDocument();
  expect(
    within(dialog).getByText("Enable public catalog data."),
  ).toBeInTheDocument();

  click(getConnectorAction("button", "Enable Public Stripe", dialog));

  await waitFor(() => {
    expect(selectedMethod).toBe("api");
    expect(
      within(getConnectorCard("Public Stripe")).getByText("API key"),
    ).toBeInTheDocument();
  });
});

test("Keep agent access independent after a manual connection", async () => {
  const researchId = "c0000000-0000-4000-a000-000000000002";
  mockConnectors(context, []);
  context.mocks.data.agents([
    listAgent("c0000000-0000-4000-a000-000000000001", "Zero"),
    listAgent(researchId, "Research Agent"),
  ]);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "axiom",
      label: "Public Axiom",
      authMethods: [
        manualMethod({
          id: "api-token",
          label: "Public API Token",
          fieldId: "apiToken",
          fieldLabel: "Public API token",
          placeholder: "public-xaat",
        }),
      ],
    }),
  ]);
  context.mocks.api(
    connectorManualGrantContract.connect,
    ({ body, respond }) => {
      return respond(200, storeConnectedConnector("axiom", body.authMethod));
    },
  );
  mockAgentConnectorAccess("axiom");
  await setupPage({
    context,
    path: "/connectors?keywords=axiom",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Axiom");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Public Axiom" });
  await fill(within(dialog).getByPlaceholderText("public-xaat"), "xaat-test");

  click(getConnectorAction("button", "Save", dialog));

  await expect(
    screen.findByText("Public Axiom connected successfully"),
  ).resolves.toBeInTheDocument();
  const naming = await screen.findByRole("dialog", {
    name: "Name your Public Axiom account",
  });
  click(getConnectorAction("button", "Skip", naming));
  await waitFor(() => {
    expect(
      within(getConnectorCard("Public Axiom")).getByText("API token"),
    ).toBeInTheDocument();
    expect(
      getConnectorAction(
        "button",
        "Manage Public Axiom access",
        getConnectorCard("Public Axiom"),
      ),
    ).toHaveTextContent("Add access");
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("Connect through device authorization", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "base44",
      label: "Base44",
      authMethods: [
        {
          id: "oauth",
          label: "OAuth",
          description: "Sign in with Base44 to grant access.",
          grantKind: "device-auth",
          manualFields: [],
          startOptions: [],
        },
      ],
    }),
  ]);
  const browserOpen = context.mocks.browser.open(createAuthWindow());
  await setupPage({
    context,
    path: "/connectors",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Base44");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Base44" });

  click(getConnectorAction("button", "Connect Base44", dialog));

  await expect(
    screen.findByTestId("connector-oauth-device-code"),
  ).resolves.toHaveTextContent("OKOU-DEVICE");
  click(within(dialog).getByTestId("connector-oauth-device-open"));
  expect(
    browserOpen.calls.some((call) => {
      return call.url?.includes("oauth.test/base44/device") ?? false;
    }),
  ).toBeTruthy();
  const naming = await screen.findByRole("dialog", {
    name: "Name your Base44 account",
  });
  click(getConnectorAction("button", "Skip", naming));
  await waitFor(() => {
    expect(
      within(getConnectorCard("Base44")).getByText("mock-base44"),
    ).toBeInTheDocument();
  });
});

test("Connect with a manual credential", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "axiom",
      label: "Public Axiom",
      authMethods: [
        manualMethod({
          id: "api-token",
          label: "Public API Token",
          fieldId: "apiToken",
          fieldLabel: "Public API token",
          placeholder: "public-xaat",
        }),
      ],
    }),
  ]);
  let submits = 0;
  let submitted: Record<string, string> | null = null;
  context.mocks.api(
    connectorManualGrantContract.connect,
    ({ body, respond }) => {
      submits += 1;
      submitted = body.values;
      return respond(200, storeConnectedConnector("axiom", body.authMethod));
    },
  );
  await setupPage({
    context,
    path: "/connectors",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Axiom");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Public Axiom" });
  expect(within(dialog).queryByText(/Settings > API Tokens/u)).toBeNull();
  await fill(within(dialog).getByPlaceholderText("public-xaat"), "xaat-test");
  const save = getConnectorAction("button", "Save", dialog);

  click(save);
  click(save);

  await waitFor(() => {
    expect(submitted).toStrictEqual({ apiToken: "xaat-test" });
    expect(submits).toBe(1);
    expect(
      within(getConnectorCard("Public Axiom")).getByText("API token"),
    ).toBeInTheDocument();
  });
});

test("Enable a connector that needs no credentials", async () => {
  const researchId = "c0000000-0000-4000-a000-000000000002";
  mockConnectors(context, []);
  context.mocks.data.agents([
    listAgent("c0000000-0000-4000-a000-000000000001", "Zero"),
    listAgent(researchId, "Research Agent"),
  ]);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Public Stripe",
      authMethods: [noAuthMethod()],
    }),
  ]);
  const browserOpen = context.mocks.browser.open(createAuthWindow());
  context.mocks.api(
    connectorNoAuthGrantContract.connect,
    ({ body, respond }) => {
      expect(body.authorizeAgent).toBeFalsy();
      return respond(200, storeConnectedConnector("stripe", body.authMethod));
    },
  );
  mockAgentConnectorAccess("stripe");
  await setupPage({
    context,
    path: "/connectors",
  });

  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Stripe");
    }),
  );

  await expect(
    screen.findByText("Public Stripe enabled successfully"),
  ).resolves.toBeInTheDocument();
  const naming = await screen.findByRole("dialog", {
    name: "Name your Public Stripe account",
  });
  click(getConnectorAction("button", "Skip", naming));
  await waitFor(() => {
    expect(
      within(getConnectorCard("Public Stripe")).getByText("API key"),
    ).toBeInTheDocument();
    expect(
      getConnectorAction(
        "button",
        "Manage Public Stripe access",
        getConnectorCard("Public Stripe"),
      ),
    ).toHaveTextContent("Add access");
  });
  expect(browserOpen.calls).toHaveLength(0);
  expect(screen.queryByText(/You've successfully connected with/u)).toBeNull();
});

test("Follow provider-authored external-code instructions", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "playstation",
      label: "PlayStation",
      authMethods: [
        {
          id: "api",
          label: "PlayStation sign-in",
          description:
            "First make sure you are signed in to PlayStation at [https://www.playstation.com/](https://www.playstation.com/).\nClick the button below, then copy the `npsso` value.",
          grantKind: "external-code",
          manualFields: [],
          startOptions: [],
        },
      ],
    }),
  ]);
  context.mocks.browser.open(createAuthWindow());
  await setupPage({ context, path: "/connectors?keywords=playstation" });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect PlayStation");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "PlayStation" });

  click(getConnectorAction("button", "Start PlayStation sign-in", dialog));

  await expect(
    waitFor(() => {
      return getConnectorAction("button", "Open PlayStation sign-in", dialog);
    }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      queryAllByRoleFast("link", dialog).map((link) => {
        return link.textContent;
      }),
    ).toStrictEqual(["https://www.playstation.com/"]);
  });
  expect(
    getConnectorAction("button", "Open PlayStation sign-in", dialog),
  ).toBeInTheDocument();
  expect(within(dialog).getByPlaceholderText("Code")).toBeInTheDocument();
});

test("Complete OAuth only after the selected connector changes", async () => {
  const researchId = "c0000000-0000-4000-a000-000000000002";
  let listed = mockConnectors(context, []);
  context.mocks.data.agents([
    listAgent("c0000000-0000-4000-a000-000000000001", "Zero"),
    listAgent(researchId, "Research Agent"),
  ]);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Public Stripe",
      authMethods: [
        {
          ...oauthMethod("Public OAuth"),
          description: "Public OAuth description",
        },
        {
          id: "cli",
          label: "Public CLI",
          description: "Public CLI description",
          grantKind: "device-auth",
          manualFields: [],
          startOptions: [],
        },
      ],
    }),
  ]);
  let authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  context.mocks.api(connectorOauthStartContract.start, ({ respond }) => {
    return respond(200, {
      authorizationUrl: "https://oauth.test/stripe/authorize",
    });
  });
  mockAgentConnectorAccess("stripe");
  context.mocks.api(connectorsMainContract.list, ({ respond }) => {
    return respond(200, { connectors: listed, connectorProvidedBindings: [] });
  });
  await setupPage({
    context,
    path: "/connectors?keywords=public+stripe",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Stripe");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Public Stripe" });
  click(getConnectorAction("button", "Connect", dialog));
  await expect(
    within(dialog).findByText("Connecting..."),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.test/stripe/authorize",
    );
  });

  context.mocks.ably.trigger("connector:changed", null);
  authWindow.close();

  await waitFor(() => {
    expect(within(dialog).queryByText("Connecting...")).not.toBeInTheDocument();
  });
  await waitFor(() => {
    const stripeCard = getConnectorCard("Public Stripe");
    expect(
      within(stripeCard).getByLabelText("Connect Public Stripe"),
    ).toBeInTheDocument();
    expect(within(stripeCard).queryByText("Connected")).toBeNull();
    expect(within(stripeCard).queryByText("Research Agent")).toBeNull();
  });

  authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  click(getConnectorAction("button", "Connect", dialog));
  await expect(
    within(dialog).findByText("Connecting..."),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.test/stripe/authorize",
    );
  });
  listed = mockConnectors(context, [
    { connectorSlug: "stripe", authMethod: "oauth" },
  ]);
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "stripe" });

  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Public Stripe" })).toBeNull();
    expect(
      within(getConnectorCard("Public Stripe")).getByText("Unnamed account"),
    ).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(
      getConnectorAction(
        "button",
        "Manage Public Stripe access",
        getConnectorCard("Public Stripe"),
      ),
    ).toHaveTextContent("Add access");
  });
});

test("Name a newly added manual account", async () => {
  mockConnectors(context, []);
  const connectionId = crypto.randomUUID();
  let renamed: { readonly id: string; readonly name: string | null } | null =
    null;
  context.mocks.api(
    connectorManualGrantContract.connect,
    ({ body, respond }) => {
      const connector = {
        ...storeConnectedConnector("ahrefs", body.authMethod),
        id: connectionId,
        externalEmail: "owner@example.com",
      };
      context.mocks.data.connectors([connector]);
      return respond(200, connector);
    },
  );
  context.mocks.api(
    connectorAccountsContract.rename,
    ({ params, body, respond }) => {
      renamed = { id: params.connectionId, name: body.displayName };
      return respond(200, {
        id: connectionId,
        target: { kind: "builtin", connectorSlug: "ahrefs" },
        authMethod: "api-token",
        displayName: body.displayName,
        isDefault: true,
        externalId: null,
        externalUsername: null,
        externalEmail: "owner@example.com",
        oauthScopes: [],
        connectionStatus: "connected",
        reconnectReason: null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      });
    },
  );
  await setupPage({
    context,
    path: "/connectors",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Ahrefs");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Ahrefs" });
  await fill(
    within(dialog).getByPlaceholderText("your-ahrefs-api-token"),
    "secret-token",
  );
  click(getConnectorAction("button", "Save", dialog));
  const naming = await screen.findByRole("dialog", {
    name: "Name your Ahrefs account",
  });
  const input = within(naming).getByLabelText("Account name");
  expect(input).toHaveValue("");
  expect(input).toHaveAttribute("placeholder", "owner@example.com");

  await fill(input, "Work");
  click(getConnectorAction("button", "Save", naming));

  await waitFor(() => {
    expect(renamed).toStrictEqual({ id: connectionId, name: "Work" });
  });
});

test("Optionally name a newly added credential-free account", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Public Stripe",
      authMethods: [noAuthMethod()],
    }),
  ]);
  const connectionId = crypto.randomUUID();
  let submittedAccount: unknown;
  let submittedAuthorizeAgent: true | undefined;
  context.mocks.api(
    connectorNoAuthGrantContract.connect,
    ({ body, respond }) => {
      submittedAccount = body.account;
      submittedAuthorizeAgent = body.authorizeAgent;
      const connector = {
        ...storeConnectedConnector("stripe", body.authMethod),
        id: connectionId,
      };
      context.mocks.data.connectors([connector]);
      return respond(200, connector);
    },
  );
  await setupPage({
    context,
    path: "/connectors",
  });

  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Stripe");
    }),
  );

  const naming = await screen.findByRole("dialog", {
    name: "Name your Public Stripe account",
  });
  expect(within(naming).getByLabelText("Account name")).toHaveAttribute(
    "placeholder",
    "API key",
  );
  click(getConnectorAction("button", "Skip", naming));
  await waitFor(() => {
    expect(getConnectorCard("Public Stripe")).toHaveTextContent("API key");
  });
  expect(submittedAccount).toStrictEqual({ intent: "add" });
  expect(submittedAuthorizeAgent).toBeUndefined();
});

test("Retry device authorization after a provider error", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Stripe",
      authMethods: [
        {
          id: "cli",
          label: "Stripe CLI",
          description: "Approve access with Stripe CLI.",
          grantKind: "device-auth",
          manualFields: [],
          startOptions: [
            {
              id: "mode",
              kind: "select",
              label: "Mode",
              required: true,
              defaultValue: "test",
              options: [
                { value: "test", label: "Test" },
                { value: "live", label: "Live" },
              ],
            },
          ],
        },
      ],
    }),
  ]);
  context.mocks.browser.open(createAuthWindow());
  const startOptions: Record<string, string>[] = [];
  context.mocks.api(
    connectorOauthDeviceAuthSessionContract.create,
    ({ body, params, respond }) => {
      startOptions.push(body.options ?? {});
      return respond(200, {
        sessionId: crypto.randomUUID(),
        sessionToken: "stripe-device-token",
        connectorSlug: params.connectorSlug,
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
  let polls = 0;
  context.mocks.http.post(
    "*/api/connectors/stripe/oauth/device/sessions/:sessionId/poll",
    () => {
      polls += 1;
      if (polls === 1) {
        return HttpResponse.json(
          {
            error: {
              message: "Stripe device authorization is unavailable",
              code: "UNAVAILABLE",
            },
          },
          { status: 500 },
        );
      }
      return HttpResponse.error();
    },
  );
  await setupPage({
    context,
    path: "/connectors",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Stripe");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Stripe" });

  click(getConnectorAction("button", "Connect Stripe", dialog));
  click(await within(dialog).findByTestId("connector-oauth-device-open"));

  await expect(
    screen.findByText("Stripe device authorization is unavailable"),
  ).resolves.toBeInTheDocument();
  expect(startOptions[0]).toStrictEqual({ mode: "test" });
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Connect Stripe", dialog),
    ).toBeEnabled();
  });

  click(getConnectorAction("button", "Connect Stripe", dialog));
  click(await within(dialog).findByTestId("connector-oauth-device-open"));
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Connect Stripe", dialog),
    ).toBeEnabled();
  });
  expect(screen.queryByText("Failed to fetch")).toBeNull();
});

test("Return Slack authorization directly to the application", async () => {
  mockConnectors(context, []);
  const { authWindow } = createReusableAuthWindow();
  context.mocks.browser.open(authWindow);
  let callbackTarget: string | undefined;
  context.mocks.api(connectorOauthStartContract.start, ({ body, respond }) => {
    callbackTarget = body.callbackTarget;
    return respond(200, {
      authorizationUrl: "https://slack.com/oauth/authorize",
    });
  });
  await setupPage({ context, path: "/connectors?keywords=slack" });

  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Slack");
    }),
  );

  await waitFor(() => {
    expect(authWindow.location.href).toBe("https://slack.com/oauth/authorize");
  });
  expect(callbackTarget).toBe("app");
});

test("Start provider sign-in for an OAuth connector", async () => {
  const providers = [
    ["airtable", "Airtable"],
    ["asana", "Asana"],
    ["cloudflare", "Cloudflare"],
    ["gumroad", "Gumroad"],
    ["hubspot", "HubSpot"],
    ["intervals-icu", "Intervals.icu"],
    ["linear", "Linear"],
    ["mercury", "Mercury"],
    ["microsoft-365", "Microsoft 365"],
    ["monday", "monday.com"],
    ["notion", "Notion"],
    ["outlook-mail", "Outlook"],
    ["sentry", "Sentry"],
    ["strava", "Strava"],
    ["todoist", "Todoist"],
    ["vercel", "Vercel"],
    ["xero", "Xero"],
    ["google-maps", "Google Maps"],
    ["meta-ads", "Meta Ads"],
  ] as const;
  mockConnectors(context, []);
  mockPublicConnectorStatus(
    context,
    providers.map(([connectorSlug, label]) => {
      return publicStatusItem({
        connectorSlug,
        label,
        authMethods: [oauthMethod()],
        singleAuthCodeAuthMethodId: "oauth",
      });
    }),
  );
  const { authWindow, reopen } = createReusableAuthWindow();
  const browserOpen = context.mocks.browser.open(authWindow);
  const starts: {
    readonly slug: string;
    readonly callbackTarget: string | undefined;
  }[] = [];
  context.mocks.api(
    connectorOauthStartContract.start,
    ({ body, params, respond }) => {
      starts.push({
        slug: params.connectorSlug,
        callbackTarget: body.callbackTarget,
      });
      authWindow.close();
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.connectorSlug}/authorize`,
      });
    },
  );
  await setupPage({ context, path: "/connectors" });
  const search = await screen.findByPlaceholderText("Find connectors");

  for (const [slug, label] of providers) {
    reopen();
    await fill(search, label);
    const connect = await waitFor(() => {
      return getConnectorAction("button", `Connect ${label}`);
    });
    await waitFor(() => {
      return expect(connect).toBeEnabled();
    });
    click(connect);
    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        `https://oauth.test/${slug}/authorize`,
      );
    });
    expect(screen.queryByRole("dialog", { name: label })).toBeNull();
    await waitFor(() => {
      expect(getConnectorAction("button", `Connect ${label}`)).toBeEnabled();
    });
  }

  expect(starts).toStrictEqual(
    providers.map(([slug]) => {
      return { slug, callbackTarget: "app" };
    }),
  );
  expect(browserOpen.calls).toHaveLength(providers.length);
  expect(
    screen.queryByText(/Meta Ads is currently in Meta's app review period/u),
  ).toBeNull();
});

test("Submit credentials only for the chosen manual method", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "axiom",
      label: "Public Axiom",
      authMethods: [
        manualMethod({
          id: "api-token",
          label: "Public API Token",
          fieldId: "apiToken",
          fieldLabel: "Public API token",
          placeholder: "public-xaat",
        }),
        manualMethod({
          id: "api",
          label: "Public API Key",
          fieldId: "apiKey",
          fieldLabel: "Public API key",
          placeholder: "public-api-key",
        }),
      ],
    }),
  ]);
  let submittedMethod: string | null = null;
  let submittedValues: Record<string, string> | null = null;
  context.mocks.api(
    connectorManualGrantContract.connect,
    ({ body, respond }) => {
      submittedMethod = body.authMethod;
      submittedValues = body.values;
      return respond(200, storeConnectedConnector("axiom", body.authMethod));
    },
  );
  await setupPage({
    context,
    path: "/connectors",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Axiom");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Public Axiom" });
  await fill(within(dialog).getByPlaceholderText("public-xaat"), "xaat-test");
  await fill(
    within(dialog).getByPlaceholderText("public-api-key"),
    "api-key-test",
  );
  const saveButtons = queryAllByRoleFast("button", dialog).filter((button) => {
    return button.textContent?.trim() === "Save";
  });
  const secondSave = saveButtons[1];
  if (!secondSave) {
    throw new Error("Expected second Save action");
  }

  click(secondSave);

  await waitFor(() => {
    expect(submittedMethod).toBe("api");
    expect(submittedValues).toStrictEqual({ apiKey: "api-key-test" });
    expect(
      within(getConnectorCard("Public Axiom")).getByText("API key"),
    ).toBeInTheDocument();
  });
});

test("Keep OAuth startup safe across repeated actions and navigation", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Public Stripe",
      icon: {
        url: "https://icons.example.test/stripe-catalog.svg",
        invertInDarkMode: true,
        scale: 1.5,
      },
      authMethods: [oauthMethod("Public OAuth")],
      singleAuthCodeAuthMethodId: "oauth",
    }),
  ]);
  const authWindow = createAuthWindow();
  const browserOpen = context.mocks.browser.open(authWindow);
  const startReady = context.mocks.deferred<void>();
  let starts = 0;
  context.mocks.api(connectorOauthStartContract.start, async ({ respond }) => {
    starts += 1;
    await startReady.promise;
    return respond(200, {
      authorizationUrl: "https://oauth.test/stripe/authorize",
    });
  });
  await setupPage({ context, path: "/connectors?keywords=public+stripe" });
  const connect = await waitFor(() => {
    return getConnectorAction("button", "Connect Public Stripe");
  });

  click(connect);
  click(connect);

  await waitFor(() => {
    expect(starts).toBe(1);
    expect(browserOpen.calls).toHaveLength(1);
  });
  window.history.pushState({}, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));

  await waitFor(() => {
    return expect(authWindow.closed).toBeTruthy();
  });
  startReady.resolve();
});

test("Show an OAuth startup failure in the provider window", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Public Stripe",
      icon: {
        url: "https://icons.example.test/stripe-error.svg",
        invertInDarkMode: false,
      },
      authMethods: [oauthMethod("Public OAuth")],
      singleAuthCodeAuthMethodId: "oauth",
    }),
  ]);
  const authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  context.mocks.api(connectorOauthStartContract.start, ({ respond }) => {
    return respond(500, {
      error: {
        message: "OAuth authorization is unavailable",
        code: "UNAVAILABLE",
      },
    });
  });
  await setupPage({ context, path: "/connectors?keywords=public+stripe" });

  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Stripe");
    }),
  );

  await waitFor(() => {
    expect(authWindow.location.href).toContain(
      "/connectors/stripe/redirecting?label=Public+Stripe",
    );
    expect(authWindow.location.href).toContain("status=error");
    expect(authWindow.location.href).toContain("stripe-error.svg");
    expect(authWindow.closed).toBeFalsy();
  });
});

test("Recover from external-code connection errors", async () => {
  let completes = 0;
  context.mocks.api(
    connectorExternalCodeSessionContract.complete,
    ({ respond }) => {
      completes += 1;
      if (completes === 1) {
        return respond(400, {
          error: { message: "Invalid AWS code", code: "BAD_REQUEST" },
        });
      }
      return respond(500, {
        error: {
          message: "AWS authorization is unavailable",
          code: "UNAVAILABLE",
        },
      });
    },
  );
  const { dialog, complete } = await openAwsWithCode("INVALID-CODE");

  click(complete);

  await expect(
    within(dialog).findByText("Invalid AWS code"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    return expect(complete).toBeEnabled();
  });

  click(complete);

  await expect(
    screen.findByText("AWS authorization is unavailable"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    return expect(complete).toBeEnabled();
  });

  context.mocks.http.post(
    "*/api/connectors/aws/external-code/sessions/:sessionId/complete",
    () => {
      return HttpResponse.error();
    },
  );
  click(complete);
  await waitFor(() => {
    return expect(complete).toBeEnabled();
  });
  expect(screen.queryByText("Failed to fetch")).toBeNull();
});
