import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
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

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((element) => {
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
      "sk-ant-test",
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
      "sk-ant-rotated",
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

  it("opens device login from a stale workspace provider banner", async () => {
    mockStaleProviderStory();
    context.mocks.browser.open(null);
    context.mocks.browser.clipboardWriteText();
    await openProvidersTab();

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("ChatGPT session needs reconnection"),
    ).toBeInTheDocument();
    expect(
      within(alert).getByText(
        "Your ChatGPT session expired. Re-connect to continue.",
      ),
    ).toBeInTheDocument();

    click(within(alert).getByText("Reconnect"));

    await waitFor(() => {
      expect(screen.getByText("Re-connect Codex")).toBeInTheDocument();
      expect(screen.getByTestId("codex-device-auth-code")).toHaveTextContent(
        "WXYZ-1234",
      );
    });

    click(screen.getByTestId("codex-device-auth-open"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Device code copied, but the approval page could not be opened. Try again.",
      );
    });
  });
});
