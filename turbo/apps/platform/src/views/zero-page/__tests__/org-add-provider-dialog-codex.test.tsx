/**
 * Tests for the Connect Codex entry on the model-providers settings tab.
 *
 * Covers:
 * - Card hidden when CodexOauthProvider feature switch is off (DoD: gate-off)
 * - Card visible when feature switch is on (DoD: gate-on)
 * - Click on the card opens the codex auth.json paste dialog
 *   (replaces the broken cross-origin OAuth redirect; #11980)
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setOrgAddProviderDialogOpen$ } from "../../../signals/zero-page/settings/org-model-providers.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import { resetMockOrgModelProviders } from "../../../mocks/handlers/api-org-model-providers.ts";

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

describe("connect Codex card — click handler", () => {
  beforeEach(() => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.CodexOauthProvider]: true,
    });
    resetMockOrgModelProviders();
  });

  it("opens the auth.json paste dialog when the codex card is clicked", async () => {
    await openProvidersPage();
    context.store.set(setOrgAddProviderDialogOpen$, true);

    const card = await screen.findByTestId(
      "org-provider-card-codex-oauth-token",
    );
    click(card);

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: /Connect Codex/i }),
      ).toBeInTheDocument();
    });
  });
});
