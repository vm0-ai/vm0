import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import {
  zeroPersonalModelProvidersByTypeContract,
  zeroPersonalModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import type {
  ModelProviderResponse,
  ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { server } from "../../../../../mocks/server.ts";
import { testContext } from "../../../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
} from "../../../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../../../mocks/msw-contract.ts";
import { setMockFeatureSwitches } from "../../../../../mocks/handlers/api-feature-switches.helpers.ts";
import { setMockPersonalModelProviders } from "../../../../../mocks/handlers/api-personal-model-providers.ts";
import { setMockUserPreferences } from "../../../../../mocks/handlers/api-user-preferences.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockPreferences(): void {
  setMockUserPreferences({
    timezone: null,
    pinnedAgentIds: [],
    sendMode: "enter",
    captureNetworkBodiesRemaining: 0,
  });
}

function makeProvider(
  type: ModelProviderType,
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    type,
    framework: type === "codex-oauth-token" ? "codex" : "claude-code",
    secretName:
      type === "codex-oauth-token"
        ? "CHATGPT_ACCESS_TOKEN"
        : "CLAUDE_CODE_OAUTH_TOKEN",
    authMethod: type === "codex-oauth-token" ? "auth_json" : null,
    secretNames:
      type === "codex-oauth-token"
        ? [
            "CHATGPT_ACCESS_TOKEN",
            "CHATGPT_REFRESH_TOKEN",
            "CHATGPT_ACCOUNT_ID",
            "CHATGPT_ID_TOKEN",
          ]
        : null,
    isDefault: false,
    selectedModel: null,
    createdAt: now,
    updatedAt: now,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    ...overrides,
  };
}

async function openModelConfiguration() {
  await waitFor(() => {
    expect(screen.getByText("Personal Models")).toBeInTheDocument();
  });
  click(screen.getByText("Personal Models"));
}

describe("personal-providers-tab — settings navigation", () => {
  it("shows the Personal Models tab", async () => {
    setMockFeatureSwitches({});
    mockPreferences();
    detachedSetupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Personal Models")).toBeInTheDocument();
    });
  });
});

describe("personal-providers-tab — OAuth-only configuration", () => {
  it("opens directly from the model-configuration tab search param", async () => {
    setMockFeatureSwitches({});
    mockPreferences();
    setMockPersonalModelProviders([]);
    detachedSetupPage({ context, path: "/settings?tab=model-configuration" });

    await waitFor(() => {
      expect(
        screen.getByText(
          /Personal Claude Code and ChatGPT subscription, used only in your own runs/,
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("ChatGPT (Codex)")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Organization admins can add more models from the Models page in organization management/,
      ),
    ).toBeInTheDocument();
  });

  it("renders fixed OAuth actions without default or add-provider UI", async () => {
    setMockFeatureSwitches({});
    mockPreferences();
    setMockPersonalModelProviders([]);
    detachedSetupPage({ context, path: "/settings" });

    await openModelConfiguration();

    await waitFor(() => {
      expect(
        screen.getByText(
          /Personal Claude Code and ChatGPT subscription, used only in your own runs/,
        ),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("oauth-card-claude-code-oauth-token"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("oauth-card-codex-oauth-token"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Connect Claude Code OAuth")).toHaveClass(
      "cursor-pointer",
    );
    expect(screen.getByLabelText("Connect ChatGPT (Codex)")).toHaveClass(
      "cursor-pointer",
    );
    expect(screen.getByText("ChatGPT (Codex)")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Connect with Codex device login for Codex-backed model routes.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByText("Personal default")).not.toBeInTheDocument();
    expect(screen.queryByText("Add credential")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No providers configured"),
    ).not.toBeInTheDocument();
  });

  it("opens the Claude Code OAuth write dialog without a model selector", async () => {
    setMockFeatureSwitches({});
    mockPreferences();
    setMockPersonalModelProviders([]);
    detachedSetupPage({ context, path: "/settings" });

    await openModelConfiguration();
    click(await screen.findByLabelText("Connect Claude Code OAuth"));

    await waitFor(() => {
      expect(
        screen.getByText("Configure Claude Code OAuth"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Claude OAuth token")).toBeInTheDocument();
    expect(screen.queryByText("Select model")).not.toBeInTheDocument();
  });

  it("shows saved OAuth state on the fixed cards", async () => {
    setMockFeatureSwitches({});
    mockPreferences();
    setMockPersonalModelProviders([
      makeProvider("claude-code-oauth-token"),
      makeProvider("codex-oauth-token", { workspaceName: "Personal Acme" }),
    ]);
    detachedSetupPage({ context, path: "/settings" });

    await openModelConfiguration();

    await waitFor(() => {
      expect(screen.getByText("ChatGPT (Codex)")).toBeInTheDocument();
    });
    expect(
      within(
        screen.getByTestId("oauth-card-claude-code-oauth-token"),
      ).getByText("Connected"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("oauth-card-codex-oauth-token")).getByText(
        "Connected",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Connected as Personal Acme"),
    ).not.toBeInTheDocument();
    click(
      within(
        screen.getByTestId("oauth-card-claude-code-oauth-token"),
      ).getByLabelText("More options"),
    );
    expect(screen.getByText("Replace")).toBeInTheDocument();
    expect(screen.getByText("Disconnect")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("oauth-card-codex-oauth-token")).getByLabelText(
        "More options",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Reconnect")).not.toBeInTheDocument();
  });

  it("disconnects ChatGPT (Codex) from the fixed card", async () => {
    setMockFeatureSwitches({});
    mockPreferences();
    setMockPersonalModelProviders([
      makeProvider("codex-oauth-token", { workspaceName: "Personal Acme" }),
    ]);
    detachedSetupPage({ context, path: "/settings" });

    await openModelConfiguration();
    click(
      within(
        await screen.findByTestId("oauth-card-codex-oauth-token"),
      ).getByLabelText("More options"),
    );
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(
        screen.getByLabelText("Connect ChatGPT (Codex)"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("More options")).not.toBeInTheDocument();
  });

  it("keeps OAuth cards visible while the provider list refreshes", async () => {
    setMockFeatureSwitches({});
    mockPreferences();
    const provider = makeProvider("codex-oauth-token", {
      workspaceName: "Personal Acme",
    });
    let listRequests = 0;
    server.use(
      mockApi(
        zeroPersonalModelProvidersMainContract.list,
        ({ respond, never }) => {
          listRequests++;
          if (listRequests === 1) {
            return respond(200, { modelProviders: [provider] });
          }
          return never();
        },
      ),
      mockApi(
        zeroPersonalModelProvidersByTypeContract.delete,
        ({ respond }) => {
          return respond(204);
        },
      ),
    );

    detachedSetupPage({ context, path: "/settings?tab=model-configuration" });

    const card = await screen.findByTestId("oauth-card-codex-oauth-token");
    click(within(card).getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(listRequests).toBeGreaterThan(1);
    });
    expect(
      screen.getByTestId("oauth-card-codex-oauth-token"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("oauth-card-skeleton")).not.toBeInTheDocument();
  });
});

describe("personal-providers-tab — ChatGPT (Codex) device login flow", () => {
  it("clicking ChatGPT (Codex) connect opens the device login dialog", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: true } as Window);
    setMockFeatureSwitches({});
    mockPreferences();
    setMockPersonalModelProviders([]);
    detachedSetupPage({ context, path: "/settings" });

    await openModelConfiguration();
    click(await screen.findByLabelText("Connect ChatGPT (Codex)"));

    await expect(
      screen.findByTestId("codex-device-auth-start"),
    ).resolves.toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Connect Codex")).toBeInTheDocument();
    expect(screen.getByText("Sign in with ChatGPT")).toBeInTheDocument();
  });

  it("opens the device reconnect dialog for stale ChatGPT (Codex)", async () => {
    setMockFeatureSwitches({});
    mockPreferences();
    setMockPersonalModelProviders([
      makeProvider("codex-oauth-token", {
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_token_expired",
      }),
    ]);
    detachedSetupPage({ context, path: "/settings" });

    await openModelConfiguration();
    await waitFor(() => {
      expect(screen.getByText("Attention")).toBeInTheDocument();
    });

    click(
      within(screen.getByTestId("oauth-card-codex-oauth-token")).getByLabelText(
        "More options",
      ),
    );
    expect(screen.getByText("Disconnect")).toBeInTheDocument();
    click(screen.getByText("Replace"));
    await expect(
      screen.findByText("Re-connect Codex"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByTestId("codex-device-auth-start")).toBeInTheDocument();
    expect(screen.getByText("Reconnect ChatGPT")).toBeInTheDocument();
    expect(
      screen.queryByText("Your ChatGPT session expired."),
    ).not.toBeInTheDocument();
  });
});
