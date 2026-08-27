import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
} from "@okouai/core";
import {
  billingCheckoutContract,
  billingUsagePackCheckoutContract,
} from "@okouai/api-contracts/contracts/billing";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorManualGrantContract,
  connectorOauthStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  PRESENTATION_LANDING_PROMPT,
  PRESENTATION_ONBOARDING_PATH,
  PRESENTATION_SHOWCASE_URL,
} from "../../../__tests__/presentation-onboarding-fixture.ts";
import { pathname } from "../../../signals/location.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { ONBOARDING_CHECKOUT_STATE_PARAM } from "../../../signals/onboarding/onboarding-state.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { detachedNavigateTo$, searchParams$ } from "../../../signals/route.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

// Keep Onboarding -> Works/Activity and Chat route transforms outside assertion
// timeouts. Production still resolves these groups lazily after route matching.
import "../../../signals/route-setups/onboarding.ts";
import "../../../signals/route-setups/activity.ts";
import "../../../signals/route-setups/chat.ts";

const context = testContext();
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const STALE_AGENT_ID = "c0000000-0000-4000-a000-000000000099";
const { set$: setLastUsedAgentId$ } = localStorageSignals(
  "zero.lastUsedAgentId",
);

function onboardingAgent(agentId: string): AgentResponse {
  return {
    agentId,
    ownerId: "user_mock",
    displayName: "Default agent",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "private",
  };
}

const MARKETING_PRESENTATION_PROMPT = [
  "/gen presentation with template `html-ppt-playful-launch`, create a 15-slide launch deck for SproutPop, a playful habit-building app for remote teams introducing a shared 30-day wellness challenge.",
  "Present it to people and culture leaders with cover, agenda, launch story, audience pain points, product vision, feature tour, rollout timeline, activation moments, team, early metrics, testimonials, pricing, and next steps.",
  "Make it saturated, joyful, idea-led, and structured.",
].join(" ");

const MARKETING_PRESENTATION_SHOWCASE =
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8199ef0a-c692-4c20-8267-e91ffe060b4c/playful-launch-presentation.html";

function templateFromUserMessage(document: UserMessageDocument | undefined) {
  const part = document?.parts.find((candidate) => {
    return candidate.type === "template";
  });
  return part?.type === "template" ? part.template : undefined;
}

function templateTypeFromUserMessage(
  document: UserMessageDocument | undefined,
): string | undefined {
  return templateFromUserMessage(document)?.type;
}

function firstItem<Item>(items: readonly Item[]): Item {
  const item = items[0];
  if (!item) {
    throw new Error("Expected onboarding template data");
  }
  return item;
}

const ONBOARDING_START_SEND_TO = "AW-18144854014/GVKdCLbQ9LscEP7_kcxD";
const CHECKOUT_START_SEND_TO = "AW-18144854014/EEovCKmuvbscEP7_kcxD";
const ADSMARCH_ONBOARDING_START_SEND_TO = "AW-18407336975/xkGcCLaRrOccEI_YpslE";
const ADSMARCH_CHECKOUT_START_SEND_TO = "AW-18407336975/hWi8CPWRrOccEI_YpslE";
const ADSMARCH_PAID_IN_ONBOARDING_SEND_TO =
  "AW-18407336975/M7QYCPiRrOccEI_YpslE";

type GtagFn = (...args: unknown[]) => void;

type WindowWithGtag = Window & {
  gtag?: GtagFn;
};

function installGtagMock(): ReturnType<typeof vi.fn<GtagFn>> {
  const windowWithGtag = window as WindowWithGtag;
  const originalGtag = windowWithGtag.gtag;
  const gtag = vi.fn<GtagFn>();

  Object.defineProperty(windowWithGtag, "gtag", {
    configurable: true,
    value: gtag,
    writable: true,
  });
  context.signal.addEventListener("abort", () => {
    if (originalGtag !== undefined) {
      Object.defineProperty(windowWithGtag, "gtag", {
        configurable: true,
        value: originalGtag,
        writable: true,
      });
      return;
    }
    Reflect.deleteProperty(windowWithGtag, "gtag");
  });

  return gtag;
}

function sentConversions(gtag: ReturnType<typeof vi.fn<GtagFn>>): string[] {
  return gtag.mock.calls.flatMap((call) => {
    const [command, eventName, params] = call;
    if (command !== "event" || eventName !== "conversion") {
      return [];
    }
    const sendTo = (params as { readonly send_to?: unknown }).send_to;
    return typeof sendTo === "string" ? [sendTo] : [];
  });
}

function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

function usePortugueseLocale(): void {
  document.documentElement.lang = "pt-BR";
  context.mocks.data.userPreferences({ locale: "pt-BR" });
  context.signal.addEventListener(
    "abort",
    () => {
      document.documentElement.lang = "en-US";
    },
    { once: true },
  );
}

function mockCatalogItem({
  slug,
  label,
  icon,
}: {
  readonly slug: PublicConnectorCatalogStatusItem["slug"];
  readonly label: string;
  readonly icon: PublicConnectorCatalogStatusItem["icon"];
}): void {
  const connector: PublicConnectorCatalogStatusItem = {
    slug,
    label,
    description: `Connect ${label} to continue`,
    icon,
    category: "developer-tools",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "oauth",
        label: "OAuth",
        description: null,
        grantKind: "auth-code",
        manualFields: [],
        startOptions: [],
      },
    ],
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
    singleAuthCodeAuthMethodId: "oauth",
    connectNotice: null,
  };
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
}

async function openMakePage(): Promise<void> {
  mockOnboardingNeeded();
  detachedSetupPage({ context, path: "/onboarding" });
  await expect(
    screen.findByRole("heading", {
      name: "What do you want to make first",
    }),
  ).resolves.toBeInTheDocument();
}

async function openGithubWorkflowRun(): Promise<void> {
  mockOnboardingNeeded();
  detachedSetupPage({
    context,
    path: "/onboarding/workflow-run?choice=workflow&category=engineering&workflow=auto-merge-github-prs",
  });
  await expect(
    screen.findByRole("heading", {
      name: "Review your workflow draft",
    }),
  ).resolves.toBeInTheDocument();
}

function chooseMakeOption(name: string): void {
  click(screen.getByRole("radio", { name: new RegExp(name, "u") }));
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryButtonByText(text, container);
  if (!button) {
    throw new Error(`Button not found for ${text}`);
  }
  return button;
}

function queryButtonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((candidate) => {
      return candidate.textContent?.includes(text) ?? false;
    }) ?? null
  );
}

function buttonsByAriaLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement[] {
  return queryAllByRoleFast("button", container).filter((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
}

function buttonByAriaLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = buttonsByAriaLabel(label, container)[0];
  if (!button) {
    throw new Error(`Button not found for aria-label ${label}`);
  }
  return button;
}

function chooseTemplate(
  title: string,
  kind: "presentation" | "illustration" | "video",
): void {
  click(buttonByAriaLabel(`Select ${title} ${kind} template`));
  click(buttonByText("Continue"));
}

describe("onboarding flow", () => {
  it("leads with Slack and opens its setup after completing onboarding", async () => {
    await openMakePage();

    const slackOption = firstItem(screen.getAllByRole("radio"));
    expect(slackOption).toHaveTextContent("Chat with Okou in Slack");
    expect(
      screen.getByTestId("onboarding-slack-illustration"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-slack-icon")).toHaveAttribute(
      "src",
      expect.stringContaining("slack-198390069136.svg"),
    );

    click(slackOption);

    await waitFor(() => {
      expect(pathname()).toBe(ROUTES.works);
    });
  });

  it.each([
    ["Generate a presentation", "Generate slides and speaker", "Presentation"],
    ["Generate images", "Create high-quality visuals", "Illustration"],
    ["Video production", "Turn your ideas into video", "Video"],
    ["Build a website", "Create and publish a shareable page", "Website"],
  ])(
    "opens the %s product templates from the make page",
    async (option, description, tab) => {
      await openMakePage();

      const makeOption = screen.getByRole("radio", {
        name: `${option} ${description}`,
      });
      click(makeOption);

      await waitFor(() => {
        const selectedTab = queryAllByRoleFast("tab").find((candidate) => {
          return (
            candidate.textContent === tab &&
            candidate.getAttribute("aria-selected") === "true"
          );
        });
        expect(selectedTab).toBeInTheDocument();
      });
    },
  );

  it("opens product templates with the new workspace default agent", async () => {
    context.store.set(setLastUsedAgentId$, STALE_AGENT_ID);
    let firstAgentRoute: string | null = null;
    context.mocks.api(agentsMainContract.list, ({ respond }) => {
      const currentPath = pathname();
      if (firstAgentRoute === null && currentPath.startsWith("/agents/")) {
        firstAgentRoute = currentPath;
      }
      return respond(200, [onboardingAgent(DEFAULT_AGENT_ID)]);
    });

    await openMakePage();
    chooseMakeOption("Generate a presentation");

    await waitFor(() => {
      expect(firstAgentRoute).toBe(`/agents/${DEFAULT_AGENT_ID}/chat`);
    });
    await waitFor(() => {
      const presentationTab = queryAllByRoleFast("tab").find((candidate) => {
        return (
          candidate.textContent === "Presentation" &&
          candidate.getAttribute("aria-selected") === "true"
        );
      });
      expect(presentationTab).toBeInTheDocument();
    });
  });

  it("shows the website choice illustration", async () => {
    await openMakePage();

    const websiteOption = screen.getByRole("radio", {
      name: /Build a website/u,
    });
    expect(websiteOption.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("v2-choice-website_80x80.png"),
    );
  });

  it("renders the workflow catalog and preview in Brazilian Portuguese", async () => {
    usePortugueseLocale();
    mockOnboardingNeeded();
    detachedSetupPage({ context, path: "/onboarding" });

    await expect(
      screen.findByRole("heading", {
        name: "O que você quer fazer primeiro",
      }),
    ).resolves.toBeInTheDocument();
    expect(document.title).toBe("Bem-vindo ao VM0 | VM0");

    click(
      screen.getByRole("radio", {
        name: /Automação de fluxo de trabalho/u,
      }),
    );

    await expect(
      screen.findByRole("heading", {
        name: "Em que você está trabalhando?",
      }),
    ).resolves.toBeInTheDocument();
    click(buttonByText("Engenharia"));

    await expect(
      screen.findByRole("heading", {
        name: "Fluxos de trabalho de Engenharia",
      }),
    ).resolves.toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").some((candidate) => {
        return candidate
          .getAttribute("aria-label")
          ?.startsWith("Auto-mergimento de PRs do GitHub");
      }),
    ).toBeTruthy();

    click(buttonByAriaLabel("Prévia dos detalhes do fluxo de trabalho"));
    const preview = await screen.findByRole("dialog", {
      name: "Auto-mergimento de PRs do GitHub",
    });
    expect(within(preview).getByText("Como funciona")).toBeVisible();
    expect(within(preview).getByText("Zero revisa a mudança")).toBeVisible();
  });

  it("renders localized onboarding template titles in Brazilian Portuguese", async () => {
    usePortugueseLocale();
    mockOnboardingNeeded();
    detachedSetupPage({
      context,
      path: "/onboarding/presentation-template?choice=presentation",
    });

    await expect(
      screen.findByRole("heading", {
        name: "Escolha um modelo de apresentação para começar",
      }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Sunburst playroom")).toBeVisible();
    expect(
      buttonByAriaLabel("Selecionar modelo de apresentação Sunburst playroom"),
    ).toBeInTheDocument();
    expect(document.title).toBe("Escolha um modelo de apresentação | VM0");
  });

  it("exposes the workspace switcher in the onboarding shell", async () => {
    mockOnboardingNeeded();
    detachedSetupPage({
      context,
      path: "/onboarding",
      org: {
        activeOrg: { id: "org_switcher", name: "Acme Workspace", slug: "acme" },
        memberships: [{ id: "org_switcher" }],
      },
    });

    await expect(
      screen.findByRole("heading", {
        name: "What do you want to make first",
      }),
    ).resolves.toBeInTheDocument();

    // The compact switcher (mobile layout) is wired into the onboarding shell.
    expect(buttonByAriaLabel("Switch workspace")).toBeInTheDocument();

    // The desktop switcher shows the active workspace name in the top-left.
    await waitFor(() => {
      expect(queryButtonByText("Acme Workspace")).not.toBeNull();
    });
  });

  it("renders workflow connector marks from catalog metadata", async () => {
    mockCatalogItem({
      slug: "github",
      label: "Catalog GitHub",
      icon: {
        url: "https://icons.example.test/onboarding-github.svg",
        invertInDarkMode: true,
        scale: 1.4,
      },
    });

    await openGithubWorkflowRun();

    const connectorLabel = await screen.findByText("Catalog GitHub");
    const connectorRow = connectorLabel.parentElement?.parentElement;
    if (!connectorRow) {
      throw new Error("Expected Catalog GitHub connector row");
    }
    const rowIcon = connectorRow.querySelector<HTMLImageElement>(
      'img[src="https://icons.example.test/onboarding-github.svg"]',
    );
    expect(rowIcon).toHaveClass("zero-icon-mono");
    expect(rowIcon).toHaveStyle({ transform: "scale(1.4)" });

    const pageIcons = document.querySelectorAll<HTMLImageElement>(
      'img[src="https://icons.example.test/onboarding-github.svg"]',
    );
    expect(pageIcons.length).toBeGreaterThanOrEqual(2);

    click(buttonByAriaLabel("Preview workflow details"));
    const preview = await screen.findByRole("dialog", {
      name: "Auto-merge GitHub PRs",
    });
    const previewIcon = preview.querySelector<HTMLImageElement>(
      'img[src="https://icons.example.test/onboarding-github.svg"]',
    );
    expect(previewIcon).toHaveClass("zero-icon-mono");
    expect(previewIcon).toHaveStyle({ transform: "scale(1.4)" });
  });

  it.each([
    {
      category: "engineering",
      workflow: "post-github-updates-slack",
      title: "Audit Google Cloud IAM and services",
      requiredConnectorSlug: "google-cloud",
      requiredCatalogLabel: "Catalog Google Cloud",
      diagramLabel: "Google Cloud",
      optionalConnector: "github",
    },
    {
      category: "data",
      workflow: "track-signup-sources-sheets",
      title: "Analyze BigQuery data in Sheets",
      requiredConnectorSlug: "google-cloud",
      requiredCatalogLabel: "Catalog Google Cloud",
      diagramLabel: "Google Cloud",
      optionalConnector: "google-analytics",
    },
    {
      category: "ceo",
      workflow: "daily-industry-news-slack",
      title: "Alert on cash flow and overdue invoices",
      requiredConnectorSlug: "quickbooks",
      requiredCatalogLabel: "Catalog QuickBooks",
      diagramLabel: "QuickBooks",
      optionalConnector: "gmail",
    },
  ] as const)(
    "renders the canonical $diagramLabel label for $category workflows",
    async ({
      category,
      workflow,
      title,
      requiredConnectorSlug,
      requiredCatalogLabel,
      diagramLabel,
      optionalConnector,
    }) => {
      mockCatalogItem({
        slug: requiredConnectorSlug,
        label: requiredCatalogLabel,
        icon: {
          url: `https://icons.example.test/onboarding-${requiredConnectorSlug}.svg`,
          invertInDarkMode: false,
        },
      });
      mockOnboardingNeeded();
      detachedSetupPage({
        context,
        path: `/onboarding/workflow-run?choice=workflow&category=${category}&workflow=${workflow}`,
      });

      await expect(
        screen.findByRole("heading", { name: title }),
      ).resolves.toBeInTheDocument();

      const requiredLabel = await screen.findByText(requiredCatalogLabel);
      const requiredRow = requiredLabel.parentElement?.parentElement;
      if (!requiredRow) {
        throw new Error(`Expected ${diagramLabel} connector row`);
      }
      expect(within(requiredRow).getByText(/^Required\s+·/u)).toBeVisible();

      const optionalLabel = screen.getByText(optionalConnector);
      const optionalRow = optionalLabel.parentElement?.parentElement;
      if (!optionalRow) {
        throw new Error(`Expected ${optionalConnector} connector row`);
      }
      expect(within(optionalRow).getByText(/^Optional\s+·/u)).toBeVisible();

      click(buttonByAriaLabel("Preview workflow details"));
      const preview = await screen.findByRole("dialog", { name: title });
      expect(
        within(preview).getByText((content) => {
          return (
            content === diagramLabel || content.startsWith(`${diagramLabel} + `)
          );
        }),
      ).toBeVisible();
    },
  );

  it.each([
    {
      category: "marketing",
      workflow: "track-keyword-ranks-ahrefs",
      title: "Audit a website's technical SEO",
      evidence: /built-in Firecrawl and DataForSEO/u,
    },
    {
      category: "support",
      workflow: "summarize-zendesk-tickets-daily",
      title: "Turn FAQs into digital-human support videos",
      evidence: /built-in avatar-video/u,
    },
  ])(
    "renders $category built-in workflow without connector setup",
    async ({ category, workflow, title, evidence }) => {
      mockOnboardingNeeded();
      context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
        return respond(200, { connectors: [] });
      });
      detachedSetupPage({
        context,
        path: `/onboarding/workflow-run?choice=workflow&category=${category}&workflow=${workflow}`,
      });

      await expect(
        screen.findByRole("heading", { name: title }),
      ).resolves.toBeInTheDocument();
      expect(screen.queryAllByTestId("connector-card-label")).toHaveLength(0);
      expect(queryButtonByText("Connect")).toBeNull();

      click(buttonByAriaLabel("Preview workflow details"));
      const preview = await screen.findByRole("dialog", { name: title });
      expect(within(preview).getByText(evidence)).toBeVisible();
      expect(preview.querySelector(".owf-diagram-node-source")).toBeNull();
      expect(preview.querySelector(".owf-diagram-dot-source")).toBeNull();
      expect(preview.querySelector('path[d="M170 81H277"]')).toBeNull();
    },
  );

  it("renders exactly six workflows for each role", async () => {
    await openMakePage();
    chooseMakeOption("Workflow automation");

    await expect(
      screen.findByRole("heading", { name: "What do you work on?" }),
    ).resolves.toBeInTheDocument();

    const roles = [
      "Everyone",
      "Engineer",
      "Product",
      "Data",
      "Marketing",
      "Sales",
      "Support",
      "CEO",
      "Operations",
    ] as const;
    let workflowCount = 0;
    for (const role of roles) {
      click(buttonByText(role));
      await expect(
        screen.findByRole("heading", { name: `${role} workflows` }),
      ).resolves.toBeInTheDocument();

      const workflowCards = screen.getAllByRole("article");
      expect(workflowCards).toHaveLength(6);
      workflowCount += workflowCards.length;

      click(buttonByText("Back"));
      await expect(
        screen.findByRole("heading", { name: "What do you work on?" }),
      ).resolves.toBeInTheDocument();
    }
    expect(workflowCount).toBe(54);
  });

  it("uses card actions throughout workflow onboarding", async () => {
    mockCatalogItem({
      slug: "github",
      label: "Catalog GitHub",
      icon: {
        url: "https://icons.example.test/onboarding-github.svg",
        invertInDarkMode: true,
      },
    });
    await openMakePage();
    expect(queryButtonByText("Continue")).toBeNull();

    click(screen.getByRole("radio", { name: /Workflow automation/u }));
    await expect(
      screen.findByRole("heading", { name: "What do you work on?" }),
    ).resolves.toBeInTheDocument();
    expect(queryButtonByText("Continue")).toBeNull();

    const everyoneCard = buttonByText("Everyone");
    expect(everyoneCard.parentElement?.firstElementChild).toBe(everyoneCard);
    const engineerCard = buttonByText("Engineer");
    expect(
      engineerCard.querySelector(
        'img[src="https://icons.example.test/onboarding-github.svg"]',
      ),
    ).not.toBeNull();
    click(buttonByText("Marketing"));

    await expect(
      screen.findByRole("heading", { name: "Marketing workflows" }),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("No connector required")).toBeNull();
    expect(queryButtonByText("Continue")).toBeNull();

    const workflowButton = queryAllByRoleFast("button").find((candidate) => {
      return candidate
        .getAttribute("aria-label")
        ?.startsWith("Audit a website's technical SEO");
    });
    if (!workflowButton) {
      throw new Error("Expected technical SEO workflow card");
    }
    click(workflowButton);
    await expect(
      screen.findByRole("heading", { name: "Review your workflow draft" }),
    ).resolves.toBeInTheDocument();
  });

  it("moves from workflow selection to a connector-aware first run", async () => {
    await openMakePage();
    chooseMakeOption("Workflow automation");

    await expect(
      screen.findByRole("heading", {
        name: "What do you work on?",
      }),
    ).resolves.toBeInTheDocument();
    click(buttonByText("Engineer"));

    await expect(
      screen.findByRole("heading", {
        name: "Engineer workflows",
      }),
    ).resolves.toBeInTheDocument();
    const workflowButton = queryAllByRoleFast("button").find((candidate) => {
      return candidate
        .getAttribute("aria-label")
        ?.startsWith("Auto-merge GitHub PRs");
    });
    expect(workflowButton).toHaveAttribute("aria-pressed", "false");

    const previewButton = buttonsByAriaLabel("Preview workflow details")[0];
    if (!previewButton) {
      throw new Error("Expected workflow preview button");
    }
    click(previewButton);
    const preview = await screen.findByRole("dialog", {
      name: "Auto-merge GitHub PRs",
    });
    expect(within(preview).getByText("How it works")).toBeVisible();
    click(buttonByText("Select this template", preview));

    await expect(
      screen.findByRole("heading", {
        name: "Review your workflow draft",
      }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Auto-merge GitHub PRs" }),
    ).toBeInTheDocument();
    expect(pathname()).toBe("/onboarding/workflow-run");
    expect(context.store.get(searchParams$).get("category")).toBe(
      "engineering",
    );
    expect(context.store.get(searchParams$).get("workflow")).toBe(
      "auto-merge-github-prs",
    );
  });

  it("allows draft creation before required connectors are connected", async () => {
    mockOnboardingNeeded();
    context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
      return respond(200, { connectors: [] });
    });
    detachedSetupPage({
      context,
      path: "/onboarding/workflow-run?choice=workflow&category=engineering&workflow=watch-sentry-after-release",
    });

    await expect(
      screen.findByRole("heading", {
        name: "Review your workflow draft",
      }),
    ).resolves.toBeInTheDocument();

    expect(buttonByText("Create workflow")).not.toBeDisabled();
    expect(screen.queryByText(/to run this workflow/u)).toBeNull();
  });

  it("keeps draft creation available when connectors are connected", async () => {
    mockOnboardingNeeded();
    context.mocks.data.connectors([
      {
        id: "11111111-1111-4111-8111-111111111112",
        slug: "notion",
        authMethod: "oauth",
        externalId: "notion-user-1",
        externalUsername: "notion-user",
        externalEmail: null,
        oauthScopes: ["read", "write"],
        connectionStatus: "connected",
        reconnectReason: null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    detachedSetupPage({
      context,
      path: "/onboarding/workflow-run?choice=workflow&category=product&workflow=summarize-user-feedback-notion",
    });

    await expect(
      screen.findByRole("heading", {
        name: "Review your workflow draft",
      }),
    ).resolves.toBeInTheDocument();

    await waitFor(() => {
      expect(buttonByText("Create workflow")).not.toBeDisabled();
    });
    expect(screen.queryByText(/to run this workflow/u)).toBeNull();
  });

  it("sends the custom workflow choice straight into the product", async () => {
    await openMakePage();
    chooseMakeOption("Workflow automation");

    await expect(
      screen.findByRole("heading", { name: "What do you work on?" }),
    ).resolves.toBeInTheDocument();
    click(buttonByText("Engineer"));

    await expect(
      screen.findByRole("heading", { name: "Engineer workflows" }),
    ).resolves.toBeInTheDocument();

    click(buttonByText("Talk to Zero and make my own"));

    await waitFor(() => {
      expect(pathname()).not.toMatch(/^\/onboarding/u);
    });
  });

  it.each([
    ["https://app.okou.ai/", "Okou"],
    ["https://pr-27200-app.omby.ai/", "Okou"],
    ["https://app.vm0.ai/", "Zero"],
  ])(
    "uses the %s assistant identity throughout custom workflow onboarding",
    async (url, assistantName) => {
      context.mocks.browser.url(url);
      let runPrompt: string | undefined;
      mockChatLifecycle(context, {
        onRunCreate: (body) => {
          runPrompt = body.prompt;
        },
      });
      mockOnboardingNeeded();

      detachedSetupPage({
        context,
        path: "/onboarding/workflow-run?choice=workflow&category=engineering&workflow=talk-to-zero",
      });

      await expect(
        screen.findByRole("heading", { name: "Describe your workflow" }),
      ).resolves.toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(
          `Describe what you want ${assistantName} to build`,
        ),
      ).toBeInTheDocument();
      await fill(
        screen.getByLabelText("Describe your workflow"),
        "Build a daily brief",
      );
      click(buttonByText(`Continue with ${assistantName}`));

      await waitFor(() => {
        expect(runPrompt).toBe(`@${assistantName} Build a daily brief`);
        expect(pathname()).toMatch(/^\/chats\//u);
      });
    },
  );

  it("preserves an explicit custom agent mention on an Okou host", async () => {
    context.mocks.browser.url("https://app.okou.ai/");
    let runPrompt: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
      },
    });
    mockOnboardingNeeded();

    detachedSetupPage({
      context,
      path: "/onboarding/workflow-run?choice=workflow&category=engineering&workflow=talk-to-zero",
    });

    await fill(
      await screen.findByLabelText("Describe your workflow"),
      "@Researcher build a daily brief",
    );
    click(buttonByText("Continue with Okou"));

    await waitFor(() => {
      expect(runPrompt).toBe("@Researcher build a daily brief");
      expect(pathname()).toMatch(/^\/chats\//u);
    });
  });

  it("starts the standard connector flow from onboarding", async () => {
    const authWindow = context.mocks.browser.authWindow();
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    context.mocks.browser.open(authWindow);
    context.mocks.api(
      connectorOauthStartContract.start,
      ({ params, respond }) => {
        expect(params.connectorSlug).toBe("github");
        return respond(200, {
          authorizationUrl: "https://oauth.test/github/authorize",
        });
      },
    );

    await openGithubWorkflowRun();
    const connectButton = await waitFor(() => {
      return buttonByText("Connect");
    });
    click(connectButton);

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/github/authorize",
      );
    });
    expect(
      screen.queryByRole("dialog", { name: "GitHub" }),
    ).not.toBeInTheDocument();
  });

  it("shows account-level connector connections as connected", async () => {
    context.mocks.data.connectors([
      {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "github",
        authMethod: "oauth",
        externalId: "github-user-1",
        externalUsername: "octocat",
        externalEmail: null,
        oauthScopes: ["repo", "project", "workflow"],
        connectionStatus: "connected",
        reconnectReason: null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await openGithubWorkflowRun();

    const githubLabel = await screen.findByText("GitHub");
    const githubRow = githubLabel.parentElement?.parentElement;
    if (!githubRow) {
      throw new Error("Expected GitHub connector row");
    }
    expect(within(githubRow).getByText("Connected")).toBeInTheDocument();
    expect(queryButtonByText("Connect", githubRow)).toBeNull();
  });

  it("runs a presentation landing-page prompt through onboarding", async () => {
    let runPrompt: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
      },
    });
    mockOnboardingNeeded();

    detachedSetupPage({
      context,
      path: PRESENTATION_ONBOARDING_PATH,
    });

    await expect(
      screen.findByRole("heading", { name: "Try this prompt" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(
      PRESENTATION_LANDING_PROMPT,
    );

    click(buttonByText("Next"));

    await waitFor(() => {
      expect(runPrompt).toBe(PRESENTATION_LANDING_PROMPT);
      expect(pathname()).toMatch(/^\/chats\//u);
    });
    const routedParams = context.store.get(searchParams$);
    expect(routedParams.has("prompt")).toBeFalsy();
    expect(routedParams.get("showcase")).toBe(PRESENTATION_SHOWCASE_URL);
    expect(routedParams.get("vm0_source")).toBe("presentation");
    expect(routedParams.get("landing_host")).toBe("www.vm0.ai");
    expect(routedParams.get("landing_path")).toBe("/en/presentation");
    expect(routedParams.get("source_type")).toBe("direct");
  });

  it("connects Ahrefs for the default agent without permission confirmation", async () => {
    context.mocks.api(
      connectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("ahrefs");
        expect(body.authMethod).toBe("api-token");
        expect(body.account).toStrictEqual({ intent: "add" });
        expect(body.authorizeAgent).toBeTruthy();
        expect(body.agentId).toBeUndefined();
        return respond(200, {
          id: "11111111-1111-4111-8111-111111111112",
          slug: "ahrefs",
          authMethod: "api-token",
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          connectionStatus: "connected",
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      },
    );
    mockOnboardingNeeded();
    detachedSetupPage({
      context,
      path: "/onboarding?prompt=Track%20keyword%20rankings&connector=ahrefs",
    });

    click(
      await waitFor(() => {
        return buttonByText("Connect");
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Ahrefs" });
    await fill(
      within(dialog).getByPlaceholderText("your-ahrefs-api-token"),
      "test-ahrefs-token",
    );
    click(buttonByText("Save"));

    await expect(screen.findByText("Connected")).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("You've successfully connected with Ahrefs!"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Ahrefs" })).toBeNull();
  });

  describe("vm0-marketing onboarding entry contract", () => {
    it("runs a presentation prompt from a marketing deep link without connectors", async () => {
      let runPrompt: string | undefined;
      mockChatLifecycle(context, {
        onRunCreate: (body) => {
          runPrompt = body.prompt;
        },
      });
      mockOnboardingNeeded();
      const params = new URLSearchParams({
        prompt: MARKETING_PRESENTATION_PROMPT,
        showcase: MARKETING_PRESENTATION_SHOWCASE,
        vm0_source: "presentation",
        landing_host: "www.vm0.ai",
        landing_path: "/en/presentation",
        source_type: "direct",
      });

      detachedSetupPage({
        context,
        path: `/onboarding?${params.toString()}`,
      });

      await expect(
        screen.findByRole("heading", { name: "Try this prompt" }),
      ).resolves.toBeInTheDocument();
      expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(
        MARKETING_PRESENTATION_PROMPT,
      );
      expect(context.store.get(searchParams$).get("connector")).toBeNull();

      click(buttonByText("Next"));

      await waitFor(() => {
        expect(runPrompt).toBe(MARKETING_PRESENTATION_PROMPT);
        expect(pathname()).toMatch(/^\/chats\//u);
      });
      const handoffParams = context.store.get(searchParams$);
      expect(handoffParams.get("showcase")).toBe(
        MARKETING_PRESENTATION_SHOWCASE,
      );
      expect(handoffParams.get("vm0_source")).toBe("presentation");
      expect(handoffParams.get("landing_host")).toBe("www.vm0.ai");
      expect(handoffParams.get("landing_path")).toBe("/en/presentation");
      expect(handoffParams.get("source_type")).toBe("direct");
    });

    it("keeps a website template through first-time onboarding", async () => {
      const websiteTemplate = WEBSITE_TEMPLATE_ITEMS.find((item) => {
        return item.id === "website-template:warm-cards";
      });
      if (!websiteTemplate) {
        throw new Error("Expected the Warm Cards website template");
      }

      let websiteTemplateId: string | undefined;
      mockChatLifecycle(context, {
        onRunCreate: (body) => {
          const template = templateFromUserMessage(body.userMessage);
          websiteTemplateId =
            template?.type === "website"
              ? template.selection.websiteTemplateId
              : undefined;
        },
      });
      mockOnboardingNeeded();
      const params = new URLSearchParams({
        prompt: "Build a warm launch page",
        template: websiteTemplate.id,
        showcase: websiteTemplate.previewUrl,
        vm0_source: "web_design",
      });

      detachedSetupPage({
        context,
        path: `/onboarding?${params.toString()}`,
      });

      await expect(
        screen.findByRole("heading", { name: "Try this prompt" }),
      ).resolves.toBeInTheDocument();
      click(buttonByText("Next"));

      await waitFor(() => {
        expect(websiteTemplateId).toBe(websiteTemplate.id);
        expect(pathname()).toMatch(/^\/chats\//u);
      });
      expect(context.store.get(searchParams$).get("showcase")).toBe(
        websiteTemplate.previewUrl,
      );
      expect(context.store.get(searchParams$).get("vm0_source")).toBe(
        "web_design",
      );
    });

    it("runs directly for an onboarded workspace", async () => {
      let runPrompt: string | undefined;
      mockChatLifecycle(context, {
        onRunCreate: (body) => {
          runPrompt = body.prompt;
        },
      });
      const params = new URLSearchParams({
        prompt: "Summarize this week's launch metrics",
        connector: "google-analytics,slack",
        vm0_source: "marketing",
        landing_path: "/en/workflow-automation-examples",
      });

      detachedSetupPage({
        context,
        path: `/onboarding?${params.toString()}`,
      });

      await waitFor(() => {
        expect(runPrompt).toBe("Summarize this week's launch metrics");
        expect(pathname()).toMatch(/^\/chats\//u);
      });
      const handoffParams = context.store.get(searchParams$);
      expect(handoffParams.get("connector")).toBeNull();
      expect(handoffParams.get("vm0_source")).toBe("marketing");
      expect(handoffParams.get("landing_path")).toBe(
        "/en/workflow-automation-examples",
      );
    });
  });

  it("keeps the presentation template deep link available", async () => {
    const template = firstItem(PRESENTATION_TEMPLATE_PICKER_ITEMS);
    mockOnboardingNeeded();
    detachedSetupPage({
      context,
      path: "/onboarding/presentation-template?choice=presentation",
    });

    await expect(
      screen.findByRole("heading", {
        name: "Pick a presentation template to start from",
      }),
    ).resolves.toBeInTheDocument();
    const templateButton = buttonByAriaLabel(
      `Select ${template.title} presentation template`,
    );
    expect(templateButton).toHaveAttribute("aria-pressed", "false");

    click(buttonByAriaLabel(`View ${template.title} presentation`));
    const preview = await screen.findByRole("dialog", {
      name: template.title,
    });
    click(buttonByAriaLabel("Show next slide", preview));
    expect(
      within(preview).getByAltText(`${template.title} slide 2`),
    ).toBeVisible();
    click(buttonByText("Select this template", preview));
    click(buttonByText("Continue"));

    await expect(
      screen.findByRole("heading", { name: "Fulfil your presentation" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/onboarding/presentation-run");
    expect(
      screen.getByLabelText("Presentation content and instruction"),
    ).toBeVisible();
    expect(context.store.get(searchParams$).get("template")).toBe(
      template.slug,
    );
  });

  it("completes image onboarding and starts the selected template run", async () => {
    const template = firstItem(ILLUSTRATION_TEMPLATE_ITEMS);
    let runPrompt: string | undefined;
    let generationType: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
        generationType = templateTypeFromUserMessage(body.userMessage);
      },
    });

    mockOnboardingNeeded();
    detachedSetupPage({
      context,
      path: "/onboarding/image-template?choice=images",
    });

    await expect(
      screen.findByRole("heading", {
        name: "Pick an illustration template to start from",
      }),
    ).resolves.toBeInTheDocument();
    chooseTemplate(template.title, "illustration");

    await expect(
      screen.findByRole("heading", {
        name: "Select one automation you would like to have a try",
      }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Custom illustration scene")).toBeVisible();
    click(buttonByText("Run now"));

    await waitFor(() => {
      expect(runPrompt).toContain(template.title);
      expect(generationType).toBe("illustration");
      expect(pathname()).toMatch(/^\/chats\//u);
    });
  });

  it("restores a long video brief from short checkout return URLs", async () => {
    const template = firstItem(VIDEO_TEMPLATE_ITEMS);
    let successUrl: string | undefined;
    let cancelUrl: string | undefined;
    let runPrompt: string | undefined;
    let generationType: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
        generationType = templateTypeFromUserMessage(body.userMessage);
      },
    });
    context.mocks.api(
      billingUsagePackCheckoutContract.create,
      ({ body, respond }) => {
        successUrl = body.successUrl;
        cancelUrl = body.cancelUrl;
        return respond(200, {
          url: "https://checkout.stripe.com/test/onboarding-video",
        });
      },
    );
    context.mocks.api(billingCheckoutContract.complete, ({ respond }) => {
      return respond(200, { completed: true });
    });

    mockOnboardingNeeded();
    detachedSetupPage({
      context,
      path: "/onboarding/video-template?choice=video",
    });

    await expect(
      screen.findByRole("heading", {
        name: "Pick a video template to start from",
      }),
    ).resolves.toBeInTheDocument();
    chooseTemplate(template.title, "video");

    await expect(
      screen.findByRole("heading", { name: "Customize your video" }),
    ).resolves.toBeInTheDocument();
    const videoBrief = "A".repeat(6000);
    await fill(screen.getByLabelText("Custom video prompt"), videoBrief);
    const upgradeButton = await waitFor(() => {
      return buttonByText("Upgrade Pro to run");
    });
    click(upgradeButton);

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/test/onboarding-video",
      );
    });
    expect(successUrl).toBeDefined();
    expect(cancelUrl).toBeDefined();
    if (!successUrl || !cancelUrl) {
      throw new Error("Expected onboarding checkout return URLs");
    }
    const success = new URL(successUrl);
    const canceled = new URL(cancelUrl);
    expect(successUrl.length).toBeLessThanOrEqual(5000);
    expect(cancelUrl.length).toBeLessThanOrEqual(5000);
    expect(success.pathname).toBe("/onboarding/video-run");
    expect(success.searchParams.get("template")).toBe(template.id);
    expect(success.searchParams.get("onboarding_template")).toBe(template.slug);
    expect(success.searchParams.has("prompt")).toBeFalsy();
    expect(success.searchParams.has("onboarding_note")).toBeFalsy();
    expect(success.searchParams.get("onboarding_billing_session_id")).toBe(
      "{CHECKOUT_SESSION_ID}",
    );
    expect(canceled.pathname).toBe("/onboarding/video-run");
    expect(canceled.searchParams.get("onboarding_billing")).toBe("canceled");
    expect(canceled.searchParams.has("prompt")).toBeFalsy();
    expect(canceled.searchParams.has("onboarding_note")).toBeFalsy();

    mockOnboardingNeeded();
    context.store.set(detachedNavigateTo$, ROUTES.onboardingVideoRun, {
      searchParams: canceled.searchParams,
    });
    await expect(
      screen.findByRole("heading", { name: "Customize your video" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Custom video prompt")).toHaveValue(
      videoBrief,
    );

    success.searchParams.set(
      "onboarding_billing_session_id",
      "cs_test_onboarding_stored",
    );
    mockOnboardingNeeded();
    context.store.set(detachedNavigateTo$, ROUTES.onboardingVideoRun, {
      searchParams: success.searchParams,
    });
    await waitFor(() => {
      expect(runPrompt).toContain(videoBrief);
      expect(generationType).toBe("video");
      expect(pathname()).toMatch(/^\/chats\//u);
    });
  });

  it("uses the Pro plan with a $20 usage pack", async () => {
    const template = firstItem(VIDEO_TEMPLATE_ITEMS);
    let usagePackCheckoutBody:
      | {
          readonly tier: "pro" | "team";
          readonly memberUsagePacks: readonly {
            readonly memberId: string;
            readonly usagePackUsd: 20 | 50 | 100 | 200;
          }[];
        }
      | undefined;
    context.mocks.api(
      billingUsagePackCheckoutContract.create,
      ({ body, respond }) => {
        usagePackCheckoutBody = body;
        return respond(200, {
          url: "https://checkout.stripe.com/test/usage-pack-onboarding-video",
        });
      },
    );

    mockOnboardingNeeded();
    detachedSetupPage({
      context,
      path: "/onboarding/video-template?choice=video",
    });
    await expect(
      screen.findByRole("heading", {
        name: "Pick a video template to start from",
      }),
    ).resolves.toBeInTheDocument();
    chooseTemplate(template.title, "video");
    await expect(
      screen.findByRole("heading", { name: "Customize your video" }),
    ).resolves.toBeInTheDocument();
    await fill(
      screen.getByLabelText("Custom video prompt"),
      "A product launch video with a fast-paced opening.",
    );
    click(buttonByText("Upgrade Pro to run"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/test/usage-pack-onboarding-video",
      );
    });
    expect(usagePackCheckoutBody).toMatchObject({
      tier: "pro",
      memberUsagePacks: [{ memberId: "test-user-123", usagePackUsd: 20 }],
    });
  });

  it("resumes a video run after checkout and completes onboarding", async () => {
    const gtag = installGtagMock();
    const template = firstItem(VIDEO_TEMPLATE_ITEMS);
    let runPrompt: string | undefined;
    let generationType: string | undefined;
    let checkoutCompletionAttempts = 0;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
        generationType = templateTypeFromUserMessage(body.userMessage);
      },
    });
    context.mocks.api(billingCheckoutContract.complete, ({ respond }) => {
      checkoutCompletionAttempts += 1;
      return respond(
        200,
        checkoutCompletionAttempts >= 2
          ? {
              completed: true,
              googleAdsConversion: {
                transactionId: "in_onboarding_paid",
                valueUsd: 49,
              },
            }
          : { completed: false },
      );
    });
    mockOnboardingNeeded();
    const params = new URLSearchParams({
      choice: "video",
      prompt: "Create a launch video",
      template: template.id,
      onboarding_billing: "pro",
      onboarding_billing_session_id: "cs_test_onboarding",
    });

    detachedSetupPage({
      context,
      path: `/onboarding/video-run?${params.toString()}`,
    });

    await waitFor(() => {
      expect(runPrompt).toBe("Create a launch video");
      expect(generationType).toBe("video");
      expect(checkoutCompletionAttempts).toBe(2);
      expect(pathname()).toMatch(/^\/chats\//u);
    });
    expect(gtag).toHaveBeenCalledWith("event", "conversion", {
      send_to: ADSMARCH_PAID_IN_ONBOARDING_SEND_TO,
      value: 49,
      currency: "USD",
      transaction_id: "in_onboarding_paid",
    });
  });

  it("returns to video configuration when checkout storage is unavailable", async () => {
    const template = firstItem(VIDEO_TEMPLATE_ITEMS);
    mockOnboardingNeeded();
    const params = new URLSearchParams({
      choice: "video",
      template: template.id,
      onboarding_template: template.slug,
      onboarding_billing: "pro",
      onboarding_billing_session_id: "cs_test_missing_storage",
      [ONBOARDING_CHECKOUT_STATE_PARAM]: "missing-state",
    });

    detachedSetupPage({
      context,
      path: `/onboarding/video-run?${params.toString()}`,
    });

    await expect(
      screen.findByRole("heading", { name: "Customize your video" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Custom video prompt")).toHaveValue("");
  });

  it("returns an invalid template deep link to its picker", async () => {
    mockOnboardingNeeded();
    detachedSetupPage({
      context,
      path: "/onboarding/image-run?template=missing-template",
    });

    await expect(
      screen.findByRole("heading", {
        name: "Pick an illustration template to start from",
      }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/onboarding/image-template");
  });

  it("restores the video brief after checkout is canceled", async () => {
    const template = firstItem(VIDEO_TEMPLATE_ITEMS);
    const note = "Keep the product in frame during the final reveal.";
    mockOnboardingNeeded();
    const params = new URLSearchParams({
      choice: "video",
      template: template.id,
      onboarding_template: template.slug,
      onboarding_billing: "canceled",
      onboarding_note: note,
    });

    detachedSetupPage({
      context,
      path: `/onboarding/video-run?${params.toString()}`,
    });

    await expect(
      screen.findByRole("heading", { name: "Customize your video" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Custom video prompt")).toHaveValue(note);
  });

  it("reports Onboarding Start and Checkout Start to Google Ads", async () => {
    const gtag = installGtagMock();
    const template = firstItem(VIDEO_TEMPLATE_ITEMS);
    mockChatLifecycle(context);
    context.mocks.api(billingCheckoutContract.create, ({ respond }) => {
      return respond(200, {
        url: "https://checkout.stripe.com/test/onboarding-video",
      });
    });

    mockOnboardingNeeded();
    detachedSetupPage({
      context,
      path: "/onboarding/video-template?choice=video",
    });

    await expect(
      screen.findByRole("heading", {
        name: "Pick a video template to start from",
      }),
    ).resolves.toBeInTheDocument();

    expect(sentConversions(gtag)).toStrictEqual([
      ONBOARDING_START_SEND_TO,
      ADSMARCH_ONBOARDING_START_SEND_TO,
    ]);
    chooseTemplate(template.title, "video");

    await expect(
      screen.findByRole("heading", { name: "Customize your video" }),
    ).resolves.toBeInTheDocument();
    await fill(
      screen.getByLabelText("Custom video prompt"),
      "A 20-second launch teaser for a habit-tracking app.",
    );
    click(
      await waitFor(() => {
        return buttonByText("Upgrade Pro to run");
      }),
    );

    await waitFor(() => {
      expect(sentConversions(gtag)).toStrictEqual([
        ONBOARDING_START_SEND_TO,
        ADSMARCH_ONBOARDING_START_SEND_TO,
        CHECKOUT_START_SEND_TO,
        ADSMARCH_CHECKOUT_START_SEND_TO,
      ]);
    });
  });
});
