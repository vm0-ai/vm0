import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { zeroClaudeCodeDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";
import type {
  ModelProviderResponse,
  OrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function staleCodexProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000201",
    type: "codex-oauth-token",
    framework: "codex",
    secretName: null,
    authMethod: "auth_json",
    secretNames: ["CODEX_AUTH_JSON"],
    isDefault: false,
    selectedModel: null,
    workspaceName: "Acme ChatGPT",
    planType: "pro",
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function staleClaudeCodeProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000203",
    type: "claude-code-oauth-token",
    framework: "claude-code",
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function anthropicApiKeyProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000202",
    type: "anthropic-api-key",
    framework: "claude-code",
    secretName: "ANTHROPIC_API_KEY",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function builtInPolicy(
  id: string,
  model: OrgModelPolicy["model"],
  modelLabel: string,
  isDefault: boolean,
): OrgModelPolicy {
  return {
    id,
    model,
    modelLabel,
    isDefault,
    defaultProviderType: "vm0",
    credentialScope: "org",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  };
}

function claudeOpusApiKeyPolicy(): OrgModelPolicy {
  return {
    id: "00000000-0000-4000-a000-000000000212",
    model: "claude-opus-4-7",
    modelLabel: "Claude Opus 4.7",
    isDefault: false,
    defaultProviderType: "anthropic-api-key",
    credentialScope: "org",
    modelProviderId: anthropicApiKeyProvider().id,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  };
}

function missingMoonshotPolicy(): OrgModelPolicy {
  return {
    id: "00000000-0000-4000-a000-000000000213",
    model: "kimi-k2.6",
    modelLabel: "Kimi K2.6",
    isDefault: false,
    defaultProviderType: "moonshot-api-key",
    credentialScope: "org",
    modelProviderId: "00000000-0000-4000-a000-000000009999",
    routeStatus: "missing_provider",
    routeStatusReason: "Workspace Moonshot API key was removed",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  };
}

function mockStaleProviderStory(): void {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([staleCodexProvider()]);
  context.mocks.api(zeroCodexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "mock-codex-device-session",
      type: "codex",
      status: "pending",
      scope: "org",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "WXYZ-1234",
      expiresIn: 30,
      interval: 1,
    });
  });
  context.mocks.api(zeroCodexDeviceAuthContract.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });
}

function mockApiKeyModelRouteStory(): void {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([anthropicApiKeyProvider()]);
  context.mocks.data.orgModelPolicies([
    builtInPolicy(
      "00000000-0000-4000-a000-000000000211",
      "deepseek-v4-pro",
      "DeepSeek V4 Pro",
      true,
    ),
    claudeOpusApiKeyPolicy(),
  ]);
}

function mockAdminOrg(): void {
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "admin",
  });
}

async function openProvidersTab(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=providers" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Models Configuration" }),
    ).toBeInTheDocument();
  });
}

async function openAddApiKeyModelDialog(): Promise<void> {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([]);
  await openProvidersTab();

  click(screen.getByText("Add model"));
  click(screen.getByRole("radio", { name: /API key/u }));
  await waitFor(() => {
    expect(
      screen.getByPlaceholderText("Enter your API key"),
    ).toBeInTheDocument();
  });
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((element) => {
    return element.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function menuItemByText(text: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((element) => {
    return element.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

function dialogContaining(element: HTMLElement): HTMLElement {
  const dialog = element.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Containing dialog not found");
  }
  return dialog;
}

describe("organization model providers settings", () => {
  it("opens a workspace API key model route form", async () => {
    await openAddApiKeyModelDialog();

    expect(screen.getByText("Anthropic API key")).toBeInTheDocument();
    expect(
      screen.getByText("Stored in workspace secrets."),
    ).toBeInTheDocument();
  });

  it("shows validation for a workspace API key model route", async () => {
    await openAddApiKeyModelDialog();

    click(buttonByText("Add model"));
    expect(screen.getByText("API key is required")).toBeInTheDocument();
  });

  it("adds a workspace API key model route", async () => {
    await openAddApiKeyModelDialog();

    await fill(
      screen.getByPlaceholderText("Enter your API key"),
      "  sk-ant-test  ",
    );
    click(buttonByText("Add model"));

    const row = await screen.findByTestId(
      "org-model-policy-row-claude-opus-4-7",
    );
    expect(within(row).getByText("Claude Opus 4.7")).toBeInTheDocument();
    expect(within(row).getByText("Anthropic")).toBeInTheDocument();
  });

  it("rotates an existing workspace API key model route", async () => {
    mockApiKeyModelRouteStory();
    await openProvidersTab();

    const row = await screen.findByTestId(
      "org-model-policy-row-claude-opus-4-7",
    );
    expect(within(row).getByText("Claude Opus 4.7")).toBeInTheDocument();
    expect(within(row).getByText("Anthropic")).toBeInTheDocument();

    click(within(row).getByLabelText("Actions for Claude Opus 4.7"));
    click(menuItemByText("Edit model"));

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Edit model" }),
      ).toBeInTheDocument();
    });
    await fill(screen.getByPlaceholderText("Enter your API key"), " ");
    click(buttonByText("Save changes"));
    expect(screen.getByText("API key is required")).toBeInTheDocument();
    await fill(
      screen.getByPlaceholderText("Enter your API key"),
      "  sk-ant-rotated  ",
    );
    click(buttonByText("Save changes"));

    await waitFor(() => {
      expect(within(row).getByText("Anthropic")).toBeInTheDocument();
    });
  });

  it("switches an existing model route to built-in and deletes it", async () => {
    mockApiKeyModelRouteStory();
    await openProvidersTab();

    const row = await screen.findByTestId(
      "org-model-policy-row-claude-opus-4-7",
    );
    expect(within(row).getByText("Anthropic")).toBeInTheDocument();
    click(within(row).getByLabelText("Actions for Claude Opus 4.7"));
    click(menuItemByText("Edit model"));

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Edit model" }),
      ).toBeInTheDocument();
    });
    click(screen.getByRole("radio", { name: /Built-in/u }));
    click(buttonByText("Save changes"));

    await waitFor(() => {
      expect(within(row).getByText("Built-in")).toBeInTheDocument();
    });

    click(within(row).getByLabelText("Actions for Claude Opus 4.7"));
    click(menuItemByText("Delete model"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("org-model-policy-row-claude-opus-4-7"),
      ).not.toBeInTheDocument();
    });
  });

  it("adds a workspace Claude subscription model route", async () => {
    mockAdminOrg();
    context.mocks.data.orgModelProviders([]);
    await openProvidersTab();

    click(buttonByText("Add model"));
    click(screen.getByRole("radio", { name: /Claude subscription/u }));
    click(buttonByText("Add model"));

    const oauthRow = await screen.findByTestId(
      "org-model-policy-row-claude-opus-4-7",
    );
    expect(within(oauthRow).getByText("Claude Opus 4.7")).toBeInTheDocument();
    expect(
      within(oauthRow).getByText("Claude Code (OAuth token)"),
    ).toBeInTheDocument();
  });

  it("adds a workspace Codex subscription model route", async () => {
    mockAdminOrg();
    context.mocks.data.orgModelProviders([]);
    context.mocks.data.orgModelPolicies([]);
    await openProvidersTab();

    click(buttonByText("Add model"));
    const dialog = screen.getByRole("dialog", { name: "Add model" });
    click(within(dialog).getByRole("combobox"));
    click(await screen.findByRole("option", { name: "GPT-5.5" }));
    click(screen.getByRole("radio", { name: /Codex subscription/u }));
    click(buttonByText("Add model", dialog));

    const codexRow = await screen.findByTestId("org-model-policy-row-gpt-5.5");
    expect(within(codexRow).getByText("GPT-5.5")).toBeInTheDocument();
    expect(within(codexRow).getByText("ChatGPT (Codex)")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("default-model-row")).getByRole("combobox"),
    ).toHaveTextContent("GPT-5.5");
  });

  it("reassigns the workspace default model when deleting the default route", async () => {
    mockApiKeyModelRouteStory();
    await openProvidersTab();

    const defaultRow = screen.getByTestId("default-model-row");
    expect(within(defaultRow).getByRole("combobox")).toHaveTextContent(
      "DeepSeek V4 Pro",
    );

    const deepseekRow = await screen.findByTestId(
      "org-model-policy-row-deepseek-v4-pro",
    );
    click(within(deepseekRow).getByLabelText("Actions for DeepSeek V4 Pro"));
    click(menuItemByText("Delete model"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("org-model-policy-row-deepseek-v4-pro"),
      ).not.toBeInTheDocument();
      expect(within(defaultRow).getByRole("combobox")).toHaveTextContent(
        "Claude Opus 4.7",
      );
    });
  });

  it("changes the workspace default model and surfaces missing provider routes", async () => {
    mockAdminOrg();
    context.mocks.data.orgModelProviders([anthropicApiKeyProvider()]);
    context.mocks.data.orgModelPolicies([
      builtInPolicy(
        "00000000-0000-4000-a000-000000000211",
        "deepseek-v4-pro",
        "DeepSeek V4 Pro",
        true,
      ),
      claudeOpusApiKeyPolicy(),
      missingMoonshotPolicy(),
    ]);
    await openProvidersTab();

    const missingRow = await screen.findByTestId(
      "org-model-policy-row-kimi-k2.6",
    );
    expect(
      within(missingRow).getByText("Missing provider"),
    ).toBeInTheDocument();
    expect(
      within(missingRow).getByText("Workspace Moonshot API key was removed"),
    ).toBeInTheDocument();

    const defaultRow = screen.getByTestId("default-model-row");
    expect(within(defaultRow).getByRole("combobox")).toHaveTextContent(
      "DeepSeek V4 Pro",
    );

    click(within(defaultRow).getByRole("combobox"));
    click(await screen.findByRole("option", { name: "Claude Opus 4.7" }));

    await waitFor(() => {
      expect(within(defaultRow).getByRole("combobox")).toHaveTextContent(
        "Claude Opus 4.7",
      );
    });
  });

  it("shows Codex waiting status after the approval page opens and code copies", async () => {
    mockStaleProviderStory();
    context.mocks.browser.open(context.mocks.browser.authWindow());
    context.mocks.browser.clipboardWriteText();
    await openProvidersTab();

    const alert = await screen.findByRole("alert");
    click(within(alert).getByText("Reconnect"));

    const code = await screen.findByTestId("codex-device-auth-code");
    const reconnectDialog = dialogContaining(code);
    click(within(reconnectDialog).getByTestId("codex-device-auth-open"));

    await waitFor(() => {
      expect(
        within(reconnectDialog).getByText(
          "Device code copied. Waiting for approval...",
        ),
      ).toBeInTheDocument();
    });
  });

  it("reconnects a stale workspace Claude Code provider", async () => {
    mockAdminOrg();
    context.mocks.data.orgModelProviders([staleClaudeCodeProvider()]);
    context.mocks.api(zeroClaudeCodeDeviceAuthContract.start, ({ respond }) => {
      return respond(200, {
        sessionToken: "mock-workspace-claude-code-session",
        type: "claude-code",
        status: "pending",
        scope: "org",
        browserUrl: "https://claude.ai/oauth/authorize",
        expiresIn: 30,
      });
    });
    context.mocks.api(
      zeroClaudeCodeDeviceAuthContract.complete,
      ({ respond }) => {
        return respond(200, {
          status: "complete",
          provider: {
            ...staleClaudeCodeProvider(),
            needsReconnect: false,
            lastRefreshErrorCode: null,
          },
          created: false,
        });
      },
    );

    await openProvidersTab();

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("Claude Code session needs reconnection"),
    ).toBeInTheDocument();
    expect(
      within(alert).getByText(
        "Your Claude Code session expired. Re-connect to continue.",
      ),
    ).toBeInTheDocument();
    click(within(alert).getByText("Reconnect"));

    const codeInput = await screen.findByTestId("claude-code-device-auth-code");
    const reconnectDialog = codeInput.closest('[role="dialog"]');
    if (!(reconnectDialog instanceof HTMLElement)) {
      throw new Error("Claude Code reconnect dialog not found");
    }
    expect(
      within(reconnectDialog).getByText("Re-connect Claude Code"),
    ).toBeInTheDocument();

    await fill(codeInput, "workspace-claude-code");
    click(
      within(reconnectDialog).getByTestId("claude-code-device-auth-submit"),
    );

    await waitFor(() => {
      expect(screen.getByText("Claude Code connected")).toBeInTheDocument();
      expect(
        screen.queryByText("Re-connect Claude Code"),
      ).not.toBeInTheDocument();
    });
  });

  it("completes a stale workspace Codex reconnect", async () => {
    mockStaleProviderStory();
    context.mocks.browser.open(context.mocks.browser.authWindow());
    context.mocks.browser.clipboardWriteText();
    context.mocks.api(zeroCodexDeviceAuthContract.complete, ({ respond }) => {
      return respond(200, {
        status: "complete",
        provider: {
          ...staleCodexProvider(),
          needsReconnect: false,
          lastRefreshErrorCode: null,
        },
        created: false,
      });
    });

    await openProvidersTab();

    const alert = await screen.findByRole("alert");
    click(within(alert).getByText("Reconnect"));

    await waitFor(() => {
      expect(screen.getByText("ChatGPT connected")).toBeInTheDocument();
      expect(screen.queryByText("Re-connect Codex")).not.toBeInTheDocument();
    });
  });

  it("cancels workspace Codex reconnect when the dialog closes", async () => {
    mockStaleProviderStory();
    let cancelledSessionToken: string | null = null;
    context.mocks.api(
      zeroCodexDeviceAuthContract.cancel,
      ({ body, respond }) => {
        cancelledSessionToken = body.sessionToken;
        return respond(200, { status: "cancelled" });
      },
    );
    await openProvidersTab();

    const alert = await screen.findByRole("alert");
    click(within(alert).getByText("Reconnect"));

    const code = await screen.findByTestId("codex-device-auth-code");
    const reconnectDialog = dialogContaining(code);
    click(within(reconnectDialog).getByLabelText("Close"));

    await waitFor(() => {
      expect(cancelledSessionToken).toBe("mock-codex-device-session");
      expect(screen.queryAllByTestId("codex-device-auth-code")).toHaveLength(0);
    });
  });
});
