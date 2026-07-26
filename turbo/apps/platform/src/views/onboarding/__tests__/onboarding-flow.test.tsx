import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
} from "@vm0/core";
import { zeroBillingCheckoutContract } from "@vm0/api-contracts/contracts/zero-billing";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorOauthStartContract,
} from "@vm0/api-contracts/contracts/zero-connectors";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { searchParams$ } from "../../../signals/route.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "../../zero-page/__tests__/chat-test-helpers.ts";

const context = testContext();

function firstItem<Item>(items: readonly Item[]): Item {
  const item = items[0];
  if (!item) {
    throw new Error("Expected onboarding template data");
  }
  return item;
}

function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

function mockGithubCatalogItem(
  icon: PublicConnectorCatalogStatusItem["icon"],
): void {
  const github: PublicConnectorCatalogStatusItem = {
    connectorRef: "github",
    label: "Catalog GitHub",
    description: "Connect Catalog GitHub to continue",
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
  context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [github] });
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
  click(buttonByText("Continue"));
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
    mockGithubCatalogItem({
      url: "https://icons.example.test/onboarding-github.svg",
      invertInDarkMode: true,
      scale: 1.4,
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
    click(buttonByText("Continue"));

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
    context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
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

    expect(buttonByText("Create draft")).not.toBeDisabled();
    expect(screen.queryByText(/to run this workflow/u)).toBeNull();
  });

  it("keeps draft creation available when connectors are connected", async () => {
    mockOnboardingNeeded();
    context.mocks.data.connectors([
      {
        id: "11111111-1111-4111-8111-111111111112",
        type: "notion",
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
      expect(buttonByText("Create draft")).not.toBeDisabled();
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
    click(buttonByText("Continue"));

    await waitFor(() => {
      expect(pathname()).not.toMatch(/^\/onboarding/u);
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
      zeroConnectorOauthStartContract.start,
      ({ params, respond }) => {
        expect(params.type).toBe("github");
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
        type: "github",
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

  it("connects Ahrefs for the default agent without permission confirmation", async () => {
    context.mocks.api(
      zeroConnectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        expect(params.type).toBe("ahrefs");
        expect(body.authMethod).toBe("api-token");
        expect(body.authorizeAgent).toBeTruthy();
        expect(body.agentId).toBeUndefined();
        return respond(200, {
          id: "11111111-1111-4111-8111-111111111112",
          type: "ahrefs",
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

  it("selects and reviews a presentation template", async () => {
    const template = firstItem(PRESENTATION_TEMPLATE_PICKER_ITEMS);
    await openMakePage();
    chooseMakeOption("Generate a presentation");

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
        generationType = body.generationTemplate?.type;
      },
    });

    await openMakePage();
    chooseMakeOption("Generate images");

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

  it("starts Pro checkout from the video run page", async () => {
    const template = firstItem(VIDEO_TEMPLATE_ITEMS);
    let successUrl: string | undefined;
    let cancelUrl: string | undefined;
    context.mocks.api(
      zeroBillingCheckoutContract.create,
      ({ body, respond }) => {
        successUrl = body.successUrl;
        cancelUrl = body.cancelUrl;
        return respond(200, {
          url: "https://checkout.stripe.com/test/onboarding-video",
        });
      },
    );

    await openMakePage();
    chooseMakeOption("Video production");

    await expect(
      screen.findByRole("heading", {
        name: "Pick a video template to start from",
      }),
    ).resolves.toBeInTheDocument();
    chooseTemplate(template.title, "video");

    await expect(
      screen.findByRole("heading", { name: "Customize your video" }),
    ).resolves.toBeInTheDocument();
    const videoBrief = "A twenty-second launch film for a travel camera.";
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
    expect(success.pathname).toBe("/onboarding/video-run");
    expect(success.searchParams.get("template")).toBe(template.id);
    expect(success.searchParams.get("onboarding_template")).toBe(template.slug);
    expect(success.searchParams.get("onboarding_billing_session_id")).toBe(
      "{CHECKOUT_SESSION_ID}",
    );
    expect(canceled.pathname).toBe("/onboarding/video-run");
    expect(canceled.searchParams.get("onboarding_billing")).toBe("canceled");
    expect(canceled.searchParams.get("onboarding_note")).toBe(videoBrief);
  });

  it("resumes a video run after checkout and completes onboarding", async () => {
    const template = firstItem(VIDEO_TEMPLATE_ITEMS);
    let runPrompt: string | undefined;
    let generationType: string | undefined;
    let checkoutCompletionAttempts = 0;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
        generationType = body.generationTemplate?.type;
      },
    });
    context.mocks.api(zeroBillingCheckoutContract.complete, ({ respond }) => {
      checkoutCompletionAttempts += 1;
      return respond(200, { completed: checkoutCompletionAttempts >= 2 });
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
});
