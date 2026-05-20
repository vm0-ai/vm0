/**
 * Tests for the Connect Codex entry on the model-providers settings tab.
 *
 * Covers:
 * - Card visible by default
 * - Click on the card opens the auth.json paste dialog while device auth is
 *   disabled
 * - Device auth starts on the dialog Connect click and opens the approval page
 *   after the API returns the device URL
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setOrgAddProviderDialogOpen$ } from "../../../signals/zero-page/settings/org-model-providers.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import { resetMockOrgModelProviders } from "../../../mocks/handlers/api-org-model-providers.ts";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();

async function openProvidersPage(options?: {
  readonly featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
}) {
  detachedSetupPage({
    context,
    path: "/?settings=providers",
    featureSwitches: options?.featureSwitches,
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("connect ChatGPT card", () => {
  beforeEach(() => {
    setMockFeatureSwitches({});
    resetMockOrgModelProviders();
  });

  it("shows the ChatGPT card by default", async () => {
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
    setMockFeatureSwitches({});
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
    expect(screen.getByTestId("codex-paste-textarea")).toBeInTheDocument();
  });

  it("opens the device approval page after the start API returns", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    server.use(
      mockApi(zeroCodexDeviceAuthContract.start, ({ body, respond }) => {
        expect(body).toStrictEqual({ scope: "org" });
        return respond(200, {
          sessionToken: "mock-codex-device-session",
          type: "codex",
          status: "pending",
          scope: "org",
          browserUrl: "https://auth.openai.com/codex/device",
          verificationCode: "ABCD-EFGH",
          expiresIn: 30,
          interval: 1,
        });
      }),
      mockApi(zeroCodexDeviceAuthContract.complete, ({ body, respond }) => {
        expect(body).toStrictEqual({
          sessionToken: "mock-codex-device-session",
        });
        return respond(200, {
          status: "complete",
          created: true,
          provider: {
            id: "00000000-0000-4000-a000-000000000139",
            type: "codex-oauth-token",
            framework: "codex",
            secretName: null,
            authMethod: "auth_json",
            secretNames: [
              "CHATGPT_ACCESS_TOKEN",
              "CHATGPT_REFRESH_TOKEN",
              "CHATGPT_ACCOUNT_ID",
              "CHATGPT_ID_TOKEN",
            ],
            isDefault: false,
            selectedModel: null,
            workspaceName: "Test Workspace",
            planType: "plus",
            needsReconnect: false,
            lastRefreshErrorCode: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        });
      }),
    );

    await openProvidersPage({
      featureSwitches: { [FeatureSwitchKey.CodexDeviceAuth]: true },
    });
    context.store.set(setOrgAddProviderDialogOpen$, true);

    click(await screen.findByTestId("org-provider-card-codex-oauth-token"));
    click(await screen.findByTestId("codex-device-auth-start"));

    await waitFor(() => {
      expect(open).toHaveBeenCalledWith(
        "https://auth.openai.com/codex/device",
        "_blank",
      );
    });
  });
});
