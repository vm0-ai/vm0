import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
} from "@vm0/core";
import { zeroBillingCheckoutContract } from "@vm0/api-contracts/contracts/zero-billing";
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

async function openMakePage(): Promise<void> {
  mockOnboardingNeeded();
  detachedSetupPage({ context, path: "/onboarding/make" });
  await expect(
    screen.findByRole("heading", {
      name: "What do you want to make first?",
    }),
  ).resolves.toBeInTheDocument();
}

async function openGithubWorkflowRun(): Promise<void> {
  mockOnboardingNeeded();
  detachedSetupPage({
    context,
    path: "/onboarding/workflow-run?choice=workflow&category=engineering&workflow=engineering-github-progress-weekly",
  });
  await expect(
    screen.findByRole("heading", { name: "GitHub progress weekly" }),
  ).resolves.toBeInTheDocument();
}

function chooseMakeOption(name: string): void {
  click(screen.getByRole("radio", { name: new RegExp(name, "u") }));
  click(buttonByText("Continue"));
}

function buttonByText(text: string): HTMLElement {
  const button = queryButtonByText(text);
  if (!button) {
    throw new Error(`Button not found for ${text}`);
  }
  return button;
}

function queryButtonByText(text: string): HTMLElement | null {
  return (
    queryAllByRoleFast("button").find((candidate) => {
      return candidate.textContent?.includes(text) ?? false;
    }) ?? null
  );
}

function chooseTemplate(title: string): void {
  const titleElement = screen.getByText(title);
  const button = titleElement.closest("button");
  if (!button) {
    throw new Error(`Template card not found for ${title}`);
  }
  click(button);
  click(buttonByText("Continue"));
}

describe("onboarding flow", () => {
  it("moves from workflow selection to a connector-aware first run", async () => {
    await openMakePage();
    chooseMakeOption("Workflow automation");

    await expect(
      screen.findByRole("heading", {
        name: "What kind of work should Zero start with?",
      }),
    ).resolves.toBeInTheDocument();
    click(buttonByText("Engineering"));

    await expect(
      screen.findByRole("heading", {
        name: "Choose a workflow for engineering",
      }),
    ).resolves.toBeInTheDocument();
    click(screen.getByRole("radio", { name: /Daily standup report/u }));
    click(buttonByText("Continue"));

    await expect(
      screen.findByRole("heading", { name: "Daily standup report" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Connect the tools for this run",
      }),
    ).toBeInTheDocument();
    expect(pathname()).toBe("/onboarding/workflow-run");
    expect(context.store.get(searchParams$).get("category")).toBe(
      "engineering",
    );
    expect(context.store.get(searchParams$).get("workflow")).toContain(
      "daily-standup-report",
    );
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

    await expect(screen.findByText("Connected")).resolves.toBeInTheDocument();
    expect(queryButtonByText("Connect")).toBeNull();
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
      path: "/onboarding/make?prompt=Track%20keyword%20rankings&connector=ahrefs",
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
        name: "Choose a presentation style",
      }),
    ).resolves.toBeInTheDocument();
    chooseTemplate(template.title);

    await expect(
      screen.findByRole("heading", { name: template.title }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/onboarding/presentation-run");
    expect(
      screen.getByLabelText("Presentation brief (optional)"),
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
      screen.findByRole("heading", { name: "Choose an illustration style" }),
    ).resolves.toBeInTheDocument();
    chooseTemplate(template.title);

    await expect(
      screen.findByRole("heading", { name: template.title }),
    ).resolves.toBeInTheDocument();
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
      screen.findByRole("heading", { name: "Choose a video style" }),
    ).resolves.toBeInTheDocument();
    chooseTemplate(template.title);

    await expect(
      screen.findByRole("heading", { name: template.title }),
    ).resolves.toBeInTheDocument();
    const videoBrief = "A twenty-second launch film for a travel camera.";
    await fill(screen.getByLabelText("Video brief (optional)"), videoBrief);
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
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
        generationType = body.generationTemplate?.type;
      },
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
      screen.findByRole("heading", { name: "Choose an illustration style" }),
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
      screen.findByRole("heading", { name: template.title }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Video brief (optional)")).toHaveValue(note);
  });
});
