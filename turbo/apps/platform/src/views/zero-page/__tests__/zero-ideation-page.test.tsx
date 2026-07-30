import { screen, waitForElementToBeRemoved } from "@testing-library/react";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { afterEach, describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { reloadConnectors$ } from "../../../signals/external/connectors.ts";
import { setIdeationActiveTab$ } from "../../../signals/zero-page/zero-ideation.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import { i18n } from "../../../i18n/index.ts";

const context = testContext();
const PT_BR_PLACEHOLDER =
  "Peça para automatizar workflows, gerenciar tarefas...";

afterEach(async () => {
  await i18n.changeLanguage("en-US");
  document.documentElement.lang = "en-US";
});

const agentId = "c0000000-0000-4000-a000-000000000001";

function publicConnectorStatusItem(
  connectorSlug: string,
): PublicConnectorCatalogStatusItem {
  return {
    connectorRef: connectorSlug,
    label: connectorSlug,
    description: `${connectorSlug} public description`,
    category: "data-automation-infrastructure",
    icon: {
      url: `https://icons.example.test/${connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    generation: [],
    tags: [],
    authMethods: [],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: null,
    connected: false,
    connectionStatus: "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  };
}

function mockConnectorCatalogStatus(connectorSlugs: readonly string[]): void {
  context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
    return respond(200, {
      connectors: connectorSlugs.map(publicConnectorStatusItem),
    });
  });
}

async function cardByTitle(title: string): Promise<HTMLElement> {
  const titleElement = await screen.findByText(title);
  const card = titleElement.closest(".zero-card");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`${title} card not found`);
  }
  return card;
}

async function suggestedPromptGrid(): Promise<HTMLElement> {
  const ideasTitle = await screen.findByText("Ideas & use cases");
  const ideasButton = ideasTitle.closest("button");
  if (!(ideasButton instanceof HTMLElement)) {
    throw new Error("Ideas & use cases button not found");
  }
  const promptGrid = ideasButton.parentElement;
  if (!(promptGrid instanceof HTMLElement)) {
    throw new Error("Suggested prompt grid not found");
  }
  return promptGrid;
}

describe("zero ideation page", () => {
  it("filters use cases and starts an agent chat from a selected idea", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    const pageTitles = await screen.findAllByText("Ideas & Use Cases");
    expect(pageTitles[0]).toBeInTheDocument();
    await expect(
      screen.findByText("Daily standup report"),
    ).resolves.toBeInTheDocument();

    await fill(screen.getByLabelText("Search use cases"), "RevenueCat");

    await expect(
      screen.findByText("RevenueCat subscription digest"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

    click(screen.getByText("RevenueCat subscription digest"));

    const composer = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    expect(composer).toHaveTextContent(
      "Set up a daily RevenueCat digest that tracks new subscriptions, renewals, and cancellations in Google Sheets and alerts on Slack for churn spikes",
    );
  });

  it("renders use case connector chips when all connectors are catalog-visible", async () => {
    mockConnectorCatalogStatus([
      "github",
      "sentry",
      "axiom",
      "plausible",
      "slack",
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    const card = await cardByTitle("Daily standup report");

    expect(card.querySelectorAll("img")).toHaveLength(5);
    expect(
      card.querySelector('img[src="https://icons.example.test/github.svg"]'),
    ).toBeInTheDocument();
  });

  it("hides use cases when any required connector is omitted from catalog", async () => {
    mockConnectorCatalogStatus(["github", "slack"]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("GitHub progress weekly"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();
  });

  it("hides connector-only use cases when catalog omits all refs", async () => {
    mockConnectorCatalogStatus([]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("Browser screenshots"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

    await fill(screen.getByLabelText("Search use cases"), "RevenueCat");

    await expect(
      screen.findByText("No use cases match your search."),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("RevenueCat subscription digest"),
    ).not.toBeInTheDocument();
  });

  it("keeps the last resolved ideas page catalog while a reload is pending", async () => {
    mockConnectorCatalogStatus([]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("Browser screenshots"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

    const catalogRequested = context.mocks.deferred<void>();
    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        catalogRequested.resolve();
        await catalogReady.promise;
        return respond(200, {
          connectors: ["github", "sentry", "axiom", "plausible", "slack"].map(
            publicConnectorStatusItem,
          ),
        });
      },
    );
    context.store.set(reloadConnectors$);

    await catalogRequested.promise;
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

    catalogReady.resolve();
    await expect(
      screen.findByText("Daily standup report"),
    ).resolves.toBeInTheDocument();
  });

  it("does not treat pending catalog status as an empty catalog", async () => {
    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        await catalogReady.promise;
        return respond(200, {
          connectors: [],
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("Daily standup report"),
    ).resolves.toBeInTheDocument();

    catalogReady.resolve();
    await waitForElementToBeRemoved(() => {
      return screen.queryByText("Daily standup report");
    });
    expect(screen.getByText("Browser screenshots")).toBeInTheDocument();
  });

  it("fails closed when catalog status errors on the ideas page", async () => {
    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        await catalogReady.promise;
        return respond(403, {
          error: { message: "Forbidden", code: "FORBIDDEN" },
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("Daily standup report"),
    ).resolves.toBeInTheDocument();

    catalogReady.resolve();
    await waitForElementToBeRemoved(() => {
      return screen.queryByText("Daily standup report");
    });
    expect(screen.getByText("Browser screenshots")).toBeInTheDocument();
  });

  it("does not reuse stale catalog data after an ideas page catalog reload errors", async () => {
    mockConnectorCatalogStatus([
      "github",
      "sentry",
      "axiom",
      "plausible",
      "slack",
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("Daily standup report"),
    ).resolves.toBeInTheDocument();

    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        await catalogReady.promise;
        return respond(403, {
          error: { message: "Forbidden", code: "FORBIDDEN" },
        });
      },
    );
    context.store.set(reloadConnectors$);

    expect(screen.getByText("Daily standup report")).toBeInTheDocument();
    catalogReady.resolve();
    await waitForElementToBeRemoved(() => {
      return screen.queryByText("Daily standup report");
    });
    expect(screen.getByText("Browser screenshots")).toBeInTheDocument();
  });

  it("falls back to all use cases when the selected tab is hidden by catalog filtering", async () => {
    mockConnectorCatalogStatus([]);
    context.store.set(setIdeationActiveTab$, "engineering");

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("Browser screenshots"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Engineering")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No use cases match your search."),
    ).not.toBeInTheDocument();
  });

  it("localizes agent chat ideas without changing the selected prompt", async () => {
    mockConnectorCatalogStatus(["agentmail"]);
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });
    context.mocks.data.onboardingStatus({ defaultAgentId: null });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.LanguagePreference]: true,
      },
    });

    await expect(
      screen.findByText("Ideias e casos de uso"),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByLabelText("Fixar na barra lateral"),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByLabelText("Ver perfil do agente"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText("Explore casos de uso em todos os conectores"),
    ).toBeInTheDocument();
    expect(screen.getByText("Ver todos")).toBeInTheDocument();
    await expect(
      screen.findByText("Caixa de entrada do AgentMail"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("AgentMail inbox")).not.toBeInTheDocument();

    click(screen.getByText("Caixa de entrada do AgentMail"));

    const composer = (await screen.findByPlaceholderText(
      PT_BR_PLACEHOLDER,
    )) as HTMLTextAreaElement;
    expect(composer).toHaveTextContent(
      "Create a new AgentMail inbox and set up email forwarding rules",
    );
  });

  it("localizes the ideas catalog without changing the selected prompt", async () => {
    mockConnectorCatalogStatus([]);
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
      featureSwitches: {
        [FeatureSwitchKey.LanguagePreference]: true,
      },
    });

    const localizedTitles = await screen.findAllByText("Ideias e casos de uso");
    expect(localizedTitles[0]).toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.textContent === "Todos";
      }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Buscar casos de uso")).toBeInTheDocument();

    click(screen.getByText("Capturas de tela do navegador"));

    const composer = (await screen.findByPlaceholderText(
      PT_BR_PLACEHOLDER,
    )) as HTMLTextAreaElement;
    expect(composer).toHaveTextContent(
      "Open this URL in the browser and take a screenshot: [paste URL]",
    );
  });

  it("does not render connector-dependent suggested prompts when catalog is empty", async () => {
    mockConnectorCatalogStatus([]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    const promptGrid = await suggestedPromptGrid();

    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });

  it("keeps the last resolved suggested prompt catalog while a reload is pending", async () => {
    mockConnectorCatalogStatus([]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    const promptGrid = await suggestedPromptGrid();
    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);

    const catalogRequested = context.mocks.deferred<void>();
    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        catalogRequested.resolve();
        await catalogReady.promise;
        return respond(200, {
          connectors: ["github", "sentry", "axiom", "plausible", "slack"].map(
            publicConnectorStatusItem,
          ),
        });
      },
    );
    context.store.set(reloadConnectors$);

    await catalogRequested.promise;
    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);

    catalogReady.resolve();
    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
  });

  it("does not treat pending catalog status as empty for suggested prompts", async () => {
    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        await catalogReady.promise;
        return respond(200, {
          connectors: [],
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    const promptGrid = await suggestedPromptGrid();
    const pendingButtons = queryAllByRoleFast("button", promptGrid);
    expect(pendingButtons).toHaveLength(3);

    catalogReady.resolve();
    await waitForElementToBeRemoved(pendingButtons.slice(0, 2));
    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);
  });

  it("fails closed when catalog status errors for suggested prompts", async () => {
    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        await catalogReady.promise;
        return respond(403, {
          error: { message: "Forbidden", code: "FORBIDDEN" },
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    const promptGrid = await suggestedPromptGrid();
    const pendingButtons = queryAllByRoleFast("button", promptGrid);
    expect(pendingButtons).toHaveLength(3);

    catalogReady.resolve();
    await waitForElementToBeRemoved(pendingButtons.slice(0, 2));
    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);
  });

  it("does not reuse stale catalog data after a suggested prompt catalog reload errors", async () => {
    mockConnectorCatalogStatus([
      "github",
      "sentry",
      "axiom",
      "plausible",
      "slack",
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    const promptGrid = await suggestedPromptGrid();
    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(3);

    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        await catalogReady.promise;
        return respond(403, {
          error: { message: "Forbidden", code: "FORBIDDEN" },
        });
      },
    );
    context.store.set(reloadConnectors$);

    const loadingButtons = queryAllByRoleFast("button", promptGrid);
    expect(loadingButtons).toHaveLength(3);

    catalogReady.resolve();
    await waitForElementToBeRemoved(loadingButtons.slice(0, 2));
    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);
  });
});
