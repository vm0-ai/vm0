import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { compile } from "tailwindcss";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  pushState,
  search as locationSearch,
} from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  getConnectorCard,
  getConnectorIcon,
  listAgent,
  mockConnectors,
  mockCustomConnectorStory,
  mockPublicConnectorStatus,
  publicStatusItem,
  queryConnectorAction,
  queryConnectorCard,
} from "./connector-page-test-helpers.ts";

const context = testContext();

function legacyConnectorFeatureSwitches() {
  return { [FeatureSwitchKey.ConnectorAccounts]: false };
}

function oauthMethod() {
  return {
    id: "oauth",
    label: "OAuth",
    description: null,
    grantKind: "auth-code" as const,
    manualFields: [],
    startOptions: [],
  };
}

async function expectCards(expected: {
  readonly github: boolean;
  readonly asana: boolean;
}): Promise<void> {
  await waitFor(() => {
    expect({
      github: queryConnectorCard("GitHub") !== null,
      asana: queryConnectorCard("Asana") !== null,
    }).toStrictEqual(expected);
  });
}

test("Browse connectors by category", async () => {
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  await setupPage({ context, path: "/connectors" });

  const engineering = await screen.findByTestId(
    "connector-category-engineering-team-execution",
  );
  const labels = within(engineering)
    .getAllByTestId("connector-card-label")
    .map((element) => {
      return element.textContent;
    });
  expect(labels).toContain("GitHub");
  expect(labels).toContain("Asana");
  const ai = screen.getByTestId("connector-category-ai");
  expect(
    ai.compareDocumentPosition(engineering) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("Honor catalog-authored connector presentation", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(
    context,
    [
      publicStatusItem({
        connectorSlug: "github",
        label: "GitHub",
        icon: {
          url: "https://icons.example.test/github.svg",
          invertInDarkMode: true,
        },
      }),
      publicStatusItem({
        connectorSlug: "slack",
        label: "Slack",
        icon: {
          url: "https://icons.example.test/slack.svg",
          invertInDarkMode: false,
          scale: 1.5,
        },
      }),
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Partner Stripe",
        category: "partner-apps",
        authMethods: [oauthMethod()],
      }),
    ],
    {
      categories: [
        {
          id: "data-automation-infrastructure",
          label: "Data / Automation / Infrastructure",
          menuLabel: "Data & automation",
          groupId: null,
        },
        {
          id: "partner-apps",
          label: "Partner Apps",
          menuLabel: "Partners",
          groupId: null,
        },
      ],
      groups: [],
    },
  );
  await setupPage({ context, path: "/connectors" });

  await expect(screen.findByText("GitHub")).resolves.toBeInTheDocument();
  expect(getConnectorIcon("GitHub")).toHaveAttribute(
    "src",
    "https://icons.example.test/github.svg",
  );
  expect(getConnectorIcon("GitHub")).toHaveClass("zero-icon-mono");
  expect(getConnectorIcon("Slack")).toHaveStyle({ transform: "scale(1.5)" });

  const partnerSection = screen.getByTestId("connector-category-partner-apps");
  expect(within(partnerSection).getByText("Partner Apps")).toBeInTheDocument();
  expect(
    screen.getByTestId("connector-category-menu-partner-apps"),
  ).toHaveTextContent("Partners");
  expect(queryConnectorCard("Partner Stripe")).toBeInTheDocument();
});

test("Show only connectors present in the current catalog", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  await setupPage({ context, path: "/connectors?keywords=stripe" });

  await expect(
    screen.findByPlaceholderText("Find connectors"),
  ).resolves.toHaveValue("stripe");
  await expect(
    screen.findByText(/No connectors matching/u),
  ).resolves.toBeInTheDocument();
  expect(queryConnectorAction("button", "Connect Stripe")).toBeNull();
});

test("Explain the catalog while its size is loading", async () => {
  mockConnectors(context, []);
  const responseReady = context.mocks.deferred<void>();
  context.mocks.api(connectorCatalogContract.discovery, async ({ respond }) => {
    await responseReady.promise;
    return respond(200, { connectors: [], totalConnectorCount: 1234 });
  });
  await setupPage({
    context,
    path: "/connectors",
  });

  await expect(
    screen.findByText("Connect third-party services for your agents to use."),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("Connect 1,234 services for your agents to use."),
  ).not.toBeInTheDocument();

  responseReady.resolve();

  await expect(
    screen.findByText("Connect 1,234 services for your agents to use."),
  ).resolves.toBeInTheDocument();
});

test("Keep connectors discoverable during category changes", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "github",
      label: "Fallback GitHub",
      category: "legacy-category",
      authMethods: [oauthMethod()],
    }),
  ]);
  await setupPage({ context, path: "/connectors" });

  const section = await screen.findByTestId(
    "connector-category-legacy-category",
  );
  expect(within(section).getByText("Legacy Category")).toBeInTheDocument();
  expect(queryConnectorCard("Fallback GitHub")).toBeInTheDocument();
});

test("Avoid duplicate catalog sections during metadata changes", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(
    context,
    [
      publicStatusItem({
        connectorSlug: "github",
        label: "Partner GitHub",
        category: "partner-apps",
        authMethods: [oauthMethod()],
      }),
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Billing Stripe",
        category: "billing-apps",
        authMethods: [oauthMethod()],
      }),
    ],
    {
      categories: [
        {
          id: "partner-apps",
          label: "Partner Apps",
          menuLabel: "Partners",
          groupId: null,
        },
        {
          id: "partner-apps",
          label: "Duplicate Partner Apps",
          menuLabel: "Duplicate Partners",
          groupId: null,
        },
        {
          id: "billing-apps",
          label: "Billing Apps",
          menuLabel: "Billing",
          groupId: "partner-apps",
        },
      ],
      groups: [
        {
          id: "partner-apps",
          label: "Partner Group",
          menuLabel: "Partner Group",
        },
      ],
    },
  );
  await setupPage({ context, path: "/connectors" });

  await expect(screen.findByText("Partner Apps")).resolves.toBeInTheDocument();
  expect(screen.queryByText("Duplicate Partner Apps")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("connector-category-partner-apps")).toHaveLength(
    1,
  );
  expect(screen.getAllByTestId("connector-category-billing-apps")).toHaveLength(
    1,
  );
  expect(screen.getAllByText("Partner GitHub")).toHaveLength(1);
  expect(queryConnectorCard("Billing Stripe")).toBeInTheDocument();
});

test("Keep expanded category navigation usable above connector controls", async () => {
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  context.mocks.api(userConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: [] });
  });
  await setupPage({ context, path: "/connectors" });

  const category = await screen.findByTestId("connector-category-menu-ai");
  category.focus();
  expect(category).toHaveFocus();
  click(category);
  const categoryLayer = category.closest("aside");
  const access = within(getConnectorCard("GitHub")).getByLabelText(
    "Manage GitHub access",
  );
  const accessLayer = access.parentElement;
  if (
    !(categoryLayer instanceof HTMLElement) ||
    !(accessLayer instanceof HTMLElement)
  ) {
    throw new Error("Expected connector stacking layers");
  }
  const compiler = await compile("@tailwind utilities;");
  const style = document.createElement("style");
  style.textContent = compiler.build([
    ...categoryLayer.classList,
    ...accessLayer.classList,
  ]);
  document.head.append(style);
  context.signal.addEventListener(
    "abort",
    () => {
      return style.remove();
    },
    {
      once: true,
    },
  );
  expect(Number(getComputedStyle(categoryLayer).zIndex)).toBeGreaterThan(
    Number(getComputedStyle(accessLayer).zIndex),
  );
});

test("Update connector visibility when availability changes", async () => {
  mockConnectors(context, []);
  const switchesReady = context.mocks.deferred<void>();
  context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
    await switchesReady.promise;
    return respond(200, {
      switches: { [FeatureSwitchKey.MailchimpConnector]: true },
      effectiveSwitches: { [FeatureSwitchKey.MailchimpConnector]: true },
    });
  });
  await setupPage({
    context,
    path: "/connectors?keywords=mailchimp",
    cachedFeatureSwitches: { [FeatureSwitchKey.MailchimpConnector]: false },
  });

  await expect(
    screen.findByText(/No connectors matching/u),
  ).resolves.toBeInTheDocument();

  switchesReady.resolve();

  await waitFor(() => {
    expect(
      getConnectorAction("button", "Connect Mailchimp"),
    ).toBeInTheDocument();
  });
  expect(locationSearch()).toBe("?keywords=mailchimp");
});

test("Filter connectors by connection state and agent", async () => {
  const researchId = "c0000000-0000-4000-a000-000000000010";
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  context.mocks.data.agents([
    listAgent(researchId, "Research Agent", "preset:0"),
  ]);
  context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
    return respond(200, {
      enabledConnectorSlugs: params.id === researchId ? ["github"] : [],
    });
  });
  await setupPage({ context, path: "/connectors" });
  await expectCards({ github: true, asana: true });

  click(getConnectorAction("button", "Filter connectors"));
  click(getConnectorAction("menuitem", "Connected"));
  await expectCards({ github: true, asana: false });
  expect(new URLSearchParams(locationSearch()).get("connection")).toBe(
    "connected",
  );

  click(getConnectorAction("button", "Filter connectors"));
  click(getConnectorAction("menuitem", "Not connected"));
  await expectCards({ github: false, asana: true });

  await fill(screen.getByPlaceholderText("Find connectors"), "git");
  click(getConnectorAction("button", "Filter connectors"));
  click(getConnectorAction("menuitem", "All"));
  await expectCards({ github: true, asana: false });
  expect(new URLSearchParams(locationSearch()).get("keywords")).toBe("git");
  expect(new URLSearchParams(locationSearch()).has("connection")).toBeFalsy();

  await fill(screen.getByPlaceholderText("Find connectors"), "");
  click(getConnectorAction("button", "Filter connectors"));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Research Agent");
    }),
  );
  await expectCards({ github: true, asana: false });
  expect(locationSearch()).toContain("connection=agent");
  expect(locationSearch()).toContain(researchId);
});

test("Navigate the connector catalog with a keyboard", async () => {
  const user = userEvent.setup({ delay: null });
  mockConnectors(context, []);
  await setupPage({ context, path: "/connectors" });
  const ai = await waitFor(() => {
    return getConnectorAction("button", "AI");
  });
  ai.focus();
  await user.keyboard("{Enter}");
  const models = getConnectorAction("button", "General Models and Reasoning");
  models.focus();
  await user.keyboard("{Enter}");
  const engineering = getConnectorAction(
    "button",
    "Engineering and Team Execution",
  );
  engineering.focus();
  await user.keyboard("{Enter}");
  const axiom = await waitFor(() => {
    return getConnectorAction("button", "Connect Axiom");
  });

  axiom.focus();
  expect(axiom).toHaveFocus();
  await user.keyboard(" ");

  await expect(
    screen.findByRole("dialog", { name: "Axiom" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Save")).toBeInTheDocument();
});

test("Use the connectors experience in Portuguese", async () => {
  const researchId = "c0000000-0000-4000-a000-000000000001";
  context.mocks.data.userPreferences({ locale: "pt-BR" });
  const [githubConnection, metaAdsConnection] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
    {
      connectorSlug: "meta-ads",
      connectionStatus: "reconnect-required",
      reconnectReason: "authorization_expired_or_revoked",
    },
  ]);
  if (!githubConnection || !metaAdsConnection) {
    throw new Error("Expected GitHub and Meta Ads connections");
  }
  mockPublicConnectorStatus(
    context,
    [
      publicStatusItem({
        connectorSlug: "github",
        label: "GitHub",
        category: "engineering-team-execution",
        connected: true,
        connectionStatus: "connected",
        connection: githubConnection,
      }),
      publicStatusItem({
        connectorSlug: "meta-ads",
        label: "Meta Ads",
        category: "engineering-team-execution",
        authMethods: [oauthMethod()],
        connected: true,
        connectionStatus: "reconnect-required",
        connection: metaAdsConnection,
        authMethodSupportsRefresh: true,
      }),
      publicStatusItem({
        connectorSlug: "openai",
        label: "OpenAI",
        category: "ai-image-video",
      }),
      publicStatusItem({
        connectorSlug: "elevenlabs",
        label: "ElevenLabs",
        category: "ai-voice-audio",
      }),
      publicStatusItem({
        connectorSlug: "langfuse",
        label: "Langfuse",
        category: "ai-memory-tracing-eval",
      }),
    ],
    {
      categories: [
        {
          id: "ai-image-video",
          label: "Image / Video Generation",
          menuLabel: "Image / Video",
          groupId: "ai",
        },
        {
          id: "ai-voice-audio",
          label: "Voice / Audio",
          menuLabel: "Voice / Audio",
          groupId: "ai",
        },
        {
          id: "ai-memory-tracing-eval",
          label: "Memory / Tracing / Evaluation",
          menuLabel: "Memory / Tracing",
          groupId: "ai",
        },
        {
          id: "engineering-team-execution",
          label: "Engineering / Team Execution",
          menuLabel: "Engineering",
          groupId: null,
        },
      ],
      groups: [{ id: "ai", label: "AI", menuLabel: "AI" }],
    },
  );
  context.mocks.data.agents([listAgent(researchId, "Research Agent")]);
  context.mocks.api(userConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: ["github"] });
  });
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, []);
  });
  await setupPage({
    context,
    path: "/connectors",
    featureSwitches: legacyConnectorFeatureSwitches(),
  });

  await expect(
    screen.findByRole("heading", { name: "Conectores" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByPlaceholderText("Buscar conectores")).toBeInTheDocument();
  expect(
    screen.getByText("Engenharia e execução da equipe"),
  ).toBeInTheDocument();
  const metaAds = getConnectorCard("Meta Ads");
  expect(within(metaAds).getByText("A conexão expirou")).toBeInTheDocument();
  click(getConnectorAction("button", "Mais opções", metaAds));
  expect(getConnectorAction("menuitem", "Reconectar")).toBeInTheDocument();

  click(
    await waitFor(() => {
      return getConnectorAction("button", "Gerenciar acesso ao GitHub");
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Gerenciar acesso ao GitHub",
  });
  expect(
    within(dialog).getByText("Escolha quais agentes podem usar este conector."),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(
      within(dialog).getByLabelText(
        "Revogar acesso ao GitHub para Research Agent",
      ),
    ).toBeInTheDocument();
  });
  click(getConnectorAction("button", "Close", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });

  await expect(
    screen.findByRole("heading", { name: "Geração de imagens e vídeos" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Voz e áudio" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", {
      name: "Memória, rastreamento e avaliação",
    }),
  ).toBeInTheDocument();
});

test("Require an application update before using connectors", async () => {
  context.mocks.http.get("*/api/connector-catalog/discovery", () => {
    return Response.json(
      { error: "Client update required" },
      { status: CLIENT_FORCE_UPGRADE_STATUS },
    );
  });
  await setupPage({ context, path: "/connectors" });

  const dialog = await screen.findByRole("dialog", { name: "Update required" });
  expect(dialog).toHaveTextContent(
    "This version of VM0 is no longer supported.",
  );
  expect(screen.queryByText("HTTP 426")).not.toBeInTheDocument();
});

test("Search connectors and preserve meaningful navigation state", async () => {
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
    { connectorSlug: "axiom", authMethod: "api-token" },
  ]);
  await setupPage({ context, path: "/connectors?keywords=axiom" });
  const search = await screen.findByPlaceholderText("Find connectors");
  expect(search).toHaveValue("axiom");
  expect(queryConnectorCard("Axiom")).toBeInTheDocument();
  expect(queryConnectorCard("GitHub")).not.toBeInTheDocument();

  await fill(search, "github");
  await waitFor(() => {
    expect(queryConnectorCard("GitHub")).toBeInTheDocument();
    expect(queryConnectorCard("Axiom")).not.toBeInTheDocument();
  });
  expect(new URLSearchParams(locationSearch()).get("keywords")).toBe("github");

  pushState({}, "", "/connectors");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await waitFor(() => {
    expect(screen.getByPlaceholderText("Find connectors")).toHaveValue("");
    expect(queryConnectorCard("GitHub")).toBeInTheDocument();
    expect(queryConnectorCard("Axiom")).toBeInTheDocument();
  });

  await fill(screen.getByPlaceholderText("Find connectors"), "missing-service");
  await expect(
    screen.findByText(/No connectors matching/u),
  ).resolves.toBeInTheDocument();
});

test("Search the full connector catalog", async () => {
  mockConnectors(context, []);
  const github = publicStatusItem({ connectorSlug: "github", label: "GitHub" });
  const slack = publicStatusItem({ connectorSlug: "slack", label: "Slack" });
  const keywords: (string | undefined)[] = [];
  context.mocks.api(
    connectorCatalogContract.discovery,
    ({ query, respond }) => {
      keywords.push(query.keyword);
      return respond(200, {
        connectors: query.keyword ? [slack] : [github],
        totalConnectorCount: 1234,
      });
    },
  );
  await setupPage({
    context,
    path: "/connectors",
  });
  await expect(screen.findByText("GitHub")).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Connect 1,234 services for your agents to use."),
  ).toBeInTheDocument();

  await fill(screen.getByPlaceholderText("Find connectors"), "Slack");

  await waitFor(() => {
    expect(queryConnectorCard("Slack")).toBeInTheDocument();
    expect(queryConnectorCard("GitHub")).not.toBeInTheDocument();
  });
  expect(keywords).toContain("Slack");
  expect(
    screen.getByText("Connect 1,234 services for your agents to use."),
  ).toBeInTheDocument();
});

test("Switch between built-in and custom connectors", async () => {
  mockCustomConnectorStory(context);
  await setupPage({ context, path: "/connectors?tab=custom" });
  const custom = await waitFor(() => {
    return getConnectorAction("tab", "Custom");
  });
  expect(custom).toHaveAttribute("aria-selected", "true");
  expect(new URLSearchParams(locationSearch()).get("tab")).toBe("custom");

  click(getConnectorAction("tab", "Built-in"));
  await waitFor(() => {
    expect(getConnectorAction("tab", "Built-in")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(new URLSearchParams(locationSearch()).has("tab")).toBeFalsy();
  });

  click(getConnectorAction("tab", "Custom"));
  await waitFor(() => {
    expect(getConnectorAction("tab", "Custom")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(new URLSearchParams(locationSearch()).get("tab")).toBe("custom");
  });
});

test("Present a connector with no accounts", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "github",
      label: "GitHub",
      description:
        "Connect your GitHub account to access repositories and GitHub features.",
      authMethods: [oauthMethod()],
      singleAuthCodeAuthMethodId: "oauth",
    }),
  ]);
  const oauthStarted = context.mocks.deferred<void>();
  context.mocks.browser.open(context.mocks.browser.authWindow());
  context.mocks.api(connectorOauthStartContract.start, async ({ respond }) => {
    await oauthStarted.promise;
    return respond(200, {
      authorizationUrl: "https://oauth.test/github/authorize",
    });
  });
  await setupPage({
    context,
    path: "/connectors",
    featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
  });
  const card = await waitFor(() => {
    return getConnectorCard("GitHub");
  });
  expect(card).toHaveTextContent(
    "Connect your GitHub account to access repositories and GitHub features.",
  );
  expect(within(card).queryByText("No accounts")).not.toBeInTheDocument();
  expect(
    queryConnectorAction("button", "Manage GitHub access", card),
  ).toBeNull();
  const connect = await waitFor(() => {
    return getConnectorAction("button", "Connect GitHub");
  });

  click(connect);
  await waitFor(() => {
    expect(getConnectorAction("button", "Connect GitHub")).toBeDisabled();
  });
  oauthStarted.resolve();
});
