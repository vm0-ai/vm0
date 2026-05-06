/**
 * Tests for the Connect ChatGPT entry on the model-providers settings tab.
 *
 * Covers:
 * - Card hidden when CodexOauthProvider feature switch is off (DoD: gate-off)
 * - Card visible when feature switch is on (DoD: gate-on)
 * - Click on the card redirects to /api/zero/chatgpt/oauth/connect (DoD: redirect)
 * - Existing-provider row renders workspace name + plan pill when fields
 *   present on codex-oauth-token provider (DoD: post-OAuth display)
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
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setOrgAddProviderDialogOpen$ } from "../../../signals/zero-page/settings/org-model-providers.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import {
  resetMockOrgModelProviders,
  setMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";

const context = testContext();

async function openProvidersPage() {
  detachedSetupPage({ context, path: "/?settings=providers" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

/**
 * Build a codex-oauth-token provider row with optional workspaceName /
 * planType fields. These fields are part of the model-provider response
 * contract (declared optional so other provider types can omit them); the
 * codex-oauth-token callback delivered in #11909 populates them.
 */
function makeChatgptProvider(
  extras: { workspaceName?: string; planType?: string } = {},
): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000010",
    type: "codex-oauth-token",
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
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-05-06T00:00:00Z",
    updatedAt: "2026-05-06T00:00:00Z",
    workspaceName: extras.workspaceName,
    planType: extras.planType,
  };
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
      screen.queryByTestId("org-provider-card-codex-oauth-token"),
    ).not.toBeInTheDocument();
  });

  it("shows the ChatGPT card when the feature switch is on", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.CodexOauthProvider]: true,
    });

    await openProvidersPage();
    context.store.set(setOrgAddProviderDialogOpen$, true);

    await waitFor(() => {
      expect(
        screen.getByTestId("org-provider-card-codex-oauth-token"),
      ).toBeInTheDocument();
    });
  });
});

describe("connect ChatGPT card — click handler", () => {
  let assignSpy: Mock;
  let originalAssign: Location["assign"];

  beforeEach(() => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.CodexOauthProvider]: true,
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
      "org-provider-card-codex-oauth-token",
    );
    click(card);

    expect(assignSpy).toHaveBeenCalledWith("/api/zero/chatgpt/oauth/connect");
  });
});

describe("provider row footer — workspace + plan display", () => {
  beforeEach(() => {
    setMockFeatureSwitches({});
    resetMockOrgModelProviders();
  });

  it("renders workspace name and plan pill when extras are present", async () => {
    setMockOrgModelProviders([
      makeChatgptProvider({
        workspaceName: "Acme Corp Workspace",
        planType: "plus",
      }),
    ]);

    await openProvidersPage();

    await waitFor(() => {
      expect(screen.getByText("Acme Corp Workspace")).toBeInTheDocument();
    });
    expect(screen.getByText("Plus")).toBeInTheDocument();
  });

  it("renders only the workspace name when planType is absent", async () => {
    setMockOrgModelProviders([
      makeChatgptProvider({ workspaceName: "Acme Corp" }),
    ]);

    await openProvidersPage();

    await waitFor(() => {
      expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/^(Plus|Pro|Business|Edu|Enterprise)$/),
    ).toBeNull();
  });

  it("renders only the workspace name when planType is an unknown string", async () => {
    // Drift guard: server may ship a value outside the known plan set
    // (e.g. "team"). Render the workspace name without a plan pill rather
    // than capitalizing an unrecognized value.
    setMockOrgModelProviders([
      makeChatgptProvider({ workspaceName: "Acme Corp", planType: "team" }),
    ]);

    await openProvidersPage();

    await waitFor(() => {
      expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    });
    expect(screen.queryByText("Team")).toBeNull();
  });

  it("falls back to 'Configured' label when extras are absent", async () => {
    setMockOrgModelProviders([makeChatgptProvider()]);

    await openProvidersPage();

    await waitFor(() => {
      expect(screen.getByText("Configured")).toBeInTheDocument();
    });
  });

  it("falls back to 'Configured' label for non-chatgpt provider types", async () => {
    setMockOrgModelProviders([
      {
        id: "00000000-0000-4000-a000-000000000020",
        type: "anthropic-api-key",
        framework: "claude-code",
        secretName: "ANTHROPIC_API_KEY",
        authMethod: null,
        secretNames: null,
        isDefault: false,
        selectedModel: null,
        needsReconnect: false,
        lastRefreshErrorCode: null,
        createdAt: "2026-05-06T00:00:00Z",
        updatedAt: "2026-05-06T00:00:00Z",
      },
    ]);

    await openProvidersPage();

    await waitFor(() => {
      expect(screen.getByText("Configured")).toBeInTheDocument();
    });
  });
});
