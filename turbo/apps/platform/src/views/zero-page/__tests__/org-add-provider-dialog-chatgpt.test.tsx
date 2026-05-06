/**
 * Tests for the Connect ChatGPT entry on the model-providers settings tab.
 *
 * Covers:
 * - Card hidden when ChatgptOauthProvider feature switch is off (DoD: gate-off)
 * - Card visible when feature switch is on (DoD: gate-on)
 * - Click on the card redirects to /api/zero/chatgpt/oauth/connect (DoD: redirect)
 * - Existing-provider row renders workspace name + plan pill when fields
 *   present on chatgpt-oauth-token provider (DoD: post-OAuth display)
 *
 * Wave 2 sub-issue of Epic #11872 (issue #11907). Server-side OAuth route
 * delivered in #11909; this test mocks the redirect target.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setOrgAddProviderDialogOpen$ } from "../../../signals/zero-page/settings/org-model-providers.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import { resetMockOrgModelProviders } from "../../../mocks/handlers/api-org-model-providers.ts";
import { ProviderRowFooter } from "../components/org-manage/org-providers-tab.tsx";

const context = testContext();

async function openProvidersPage() {
  detachedSetupPage({ context, path: "/?settings=providers" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("connect ChatGPT card — feature switch gating", () => {
  beforeEach(() => {
    setMockFeatureSwitches({});
    resetMockOrgModelProviders();
  });

  it("hides the ChatGPT card when the feature switch is off", async () => {
    await openProvidersPage();
    context.store.set(setOrgAddProviderDialogOpen$, true);

    await waitFor(() => {
      expect(screen.getAllByRole("dialog").length).toBeGreaterThan(0);
    });

    expect(
      screen.queryByTestId("org-provider-card-chatgpt-oauth-token"),
    ).not.toBeInTheDocument();
  });

  it("shows the ChatGPT card when the feature switch is on", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.ChatgptOauthProvider]: true,
    });

    await openProvidersPage();
    context.store.set(setOrgAddProviderDialogOpen$, true);

    await waitFor(() => {
      expect(
        screen.getByTestId("org-provider-card-chatgpt-oauth-token"),
      ).toBeInTheDocument();
    });
  });
});

describe("connect ChatGPT card — click handler", () => {
  let assignSpy: Mock;
  let originalAssign: Location["assign"];

  beforeEach(() => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.ChatgptOauthProvider]: true,
    });
    resetMockOrgModelProviders();
    // jsdom marks window.location.assign as non-configurable in some versions;
    // replace it via defineProperty so we can spy without "Cannot redefine".
    originalAssign = window.location.assign;
    assignSpy = vi.fn();
    Object.defineProperty(window.location, "assign", {
      configurable: true,
      value: assignSpy,
    });
  });

  afterEach(() => {
    Object.defineProperty(window.location, "assign", {
      configurable: true,
      value: originalAssign,
    });
  });

  it("redirects to /api/zero/chatgpt/oauth/connect when card is clicked", async () => {
    await openProvidersPage();
    context.store.set(setOrgAddProviderDialogOpen$, true);

    const card = await screen.findByTestId(
      "org-provider-card-chatgpt-oauth-token",
    );
    click(card);

    expect(assignSpy).toHaveBeenCalledWith("/api/zero/chatgpt/oauth/connect");
  });
});

describe("providerRowFooter — workspace + plan display", () => {
  function makeChatgptProvider(
    extras: { workspaceName?: string; planType?: string } = {},
  ): ModelProviderResponse {
    const base: ModelProviderResponse = {
      id: "00000000-0000-4000-a000-000000000010",
      type: "chatgpt-oauth-token",
      framework: "codex",
      secretName: "CHATGPT_ACCESS_TOKEN",
      authMethod: "oauth",
      secretNames: [
        "CHATGPT_ACCESS_TOKEN",
        "CHATGPT_REFRESH_TOKEN",
        "CHATGPT_ACCOUNT_ID",
        "CHATGPT_ID_TOKEN",
      ],
      isDefault: true,
      selectedModel: null,
      createdAt: "2026-05-06T00:00:00Z",
      updatedAt: "2026-05-06T00:00:00Z",
    };
    // Forward-compatible extras delivered by #11909 — the platform reads them
    // defensively, so attaching them here on top of the contract type works
    // for the test today and will be a no-op cast once the contract widens.
    return { ...base, ...extras } as ModelProviderResponse;
  }

  it("renders workspace name and plan pill when extras are present", () => {
    render(
      <ProviderRowFooter
        provider={makeChatgptProvider({
          workspaceName: "Acme Corp Workspace",
          planType: "plus",
        })}
      />,
    );

    expect(screen.getByText("Acme Corp Workspace")).toBeInTheDocument();
    expect(screen.getByText("Plus")).toBeInTheDocument();
  });

  it("renders only the workspace name when planType is absent", () => {
    render(
      <ProviderRowFooter
        provider={makeChatgptProvider({ workspaceName: "Acme Corp" })}
      />,
    );

    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(
      screen.queryByText(/^(Plus|Pro|Business|Edu|Enterprise)$/),
    ).toBeNull();
  });

  it("falls back to 'Configured' label when extras are absent", () => {
    render(<ProviderRowFooter provider={makeChatgptProvider()} />);

    expect(screen.getByText("Configured")).toBeInTheDocument();
  });

  it("falls back to 'Configured' label for non-chatgpt provider types", () => {
    const anthropic: ModelProviderResponse = {
      id: "00000000-0000-4000-a000-000000000020",
      type: "anthropic-api-key",
      framework: "claude-code",
      secretName: "ANTHROPIC_API_KEY",
      authMethod: null,
      secretNames: null,
      isDefault: false,
      selectedModel: null,
      createdAt: "2026-05-06T00:00:00Z",
      updatedAt: "2026-05-06T00:00:00Z",
    };

    render(<ProviderRowFooter provider={anthropic} />);

    expect(screen.getByText("Configured")).toBeInTheDocument();
  });
});
