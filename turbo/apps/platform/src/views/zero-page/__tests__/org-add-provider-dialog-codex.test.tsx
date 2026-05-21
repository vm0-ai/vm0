/**
 * Tests for the Connect Codex entry on the model-providers settings tab.
 *
 * Covers:
 * - Card visible by default
 * - Click on the card opens the Codex device login dialog
 * - Device auth starts on the dialog Connect click, shows the device code, and
 *   waits for an explicit click before copying the code and opening OpenAI
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setOrgAddProviderDialogOpen$ } from "../../../signals/zero-page/settings/org-model-providers.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import { resetMockOrgModelProviders } from "../../../mocks/handlers/api-org-model-providers.ts";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();

async function openProvidersPage() {
  detachedSetupPage({
    context,
    path: "/?settings=providers",
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

  it("opens the device login dialog when the codex card is clicked", async () => {
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
    expect(screen.getByTestId("codex-device-auth-start")).toBeInTheDocument();
    expect(screen.getByText("Sign in with ChatGPT")).toBeInTheDocument();
  });

  it("keeps the connect button visible and loading while preparing", async () => {
    server.use(
      mockApi(zeroCodexDeviceAuthContract.start, async ({ never }) => {
        return await never();
      }),
    );

    await openProvidersPage();
    context.store.set(setOrgAddProviderDialogOpen$, true);

    click(await screen.findByTestId("org-provider-card-codex-oauth-token"));
    click(await screen.findByTestId("codex-device-auth-start"));

    await waitFor(() => {
      const startButton = screen.getByTestId("codex-device-auth-start");
      expect(startButton).toBeDisabled();
      expect(startButton).toHaveTextContent("Preparing...");
    });
    expect(
      screen.queryByText("Preparing Codex login…"),
    ).not.toBeInTheDocument();
  });

  it("copies the device code and opens the approval page only after user clicks", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const writeText = vi.fn<(text: string) => Promise<void>>();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    let resolveComplete: (() => void) | undefined;
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
      mockApi(
        zeroCodexDeviceAuthContract.complete,
        async ({ body, deferred, respond }) => {
          const gate = deferred<void>();
          resolveComplete = () => {
            gate.resolve();
          };
          await gate.promise;
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
        },
      ),
    );

    await openProvidersPage();
    context.store.set(setOrgAddProviderDialogOpen$, true);

    click(await screen.findByTestId("org-provider-card-codex-oauth-token"));
    click(await screen.findByTestId("codex-device-auth-start"));

    await expect(
      screen.findByTestId("codex-device-auth-code"),
    ).resolves.toHaveTextContent("ABCD-EFGH");
    expect(open).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    click(screen.getByTestId("codex-device-auth-open"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("ABCD-EFGH");
      expect(open).toHaveBeenCalledWith(
        "https://auth.openai.com/codex/device",
        "_blank",
      );
    });
    expect(resolveComplete).toBeDefined();
    resolveComplete?.();

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /Connect Codex/i }),
      ).not.toBeInTheDocument();
    });
  });

  it("cancels the Codex sandbox when the connect dialog closes", async () => {
    const cancelBodies: unknown[] = [];
    server.use(
      mockApi(zeroCodexDeviceAuthContract.start, ({ respond }) => {
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
      mockApi(zeroCodexDeviceAuthContract.complete, ({ respond }) => {
        return respond(200, {
          status: "pending",
          errorMessage: null,
        });
      }),
      mockApi(zeroCodexDeviceAuthContract.cancel, ({ body, respond }) => {
        cancelBodies.push(body);
        return respond(200, { status: "cancelled" });
      }),
    );

    await openProvidersPage();
    context.store.set(setOrgAddProviderDialogOpen$, true);

    click(await screen.findByTestId("org-provider-card-codex-oauth-token"));
    click(await screen.findByTestId("codex-device-auth-start"));

    await expect(
      screen.findByTestId("codex-device-auth-code"),
    ).resolves.toHaveTextContent("ABCD-EFGH");

    const dialog = screen.getByRole("dialog", { name: /Connect Codex/i });
    click(within(dialog).getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /Connect Codex/i }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(cancelBodies).toStrictEqual([
        { sessionToken: "mock-codex-device-session" },
      ]);
    });
  });
});
