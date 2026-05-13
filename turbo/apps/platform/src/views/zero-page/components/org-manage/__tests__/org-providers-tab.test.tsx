/**
 * Tests for OrgProvidersTab — specifically the stale-session reconnect
 * banner button (#11980 replaces the broken cross-origin <a href> with a
 * button that opens the codex auth.json paste dialog in reconnect mode).
 *
 * Covers:
 * - Re-paste button opens the paste dialog with reconnect title
 * - Successful re-paste clears needsReconnect → banner unmounts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { server } from "../../../../../mocks/server.ts";
import { mockApi } from "../../../../../mocks/msw-contract.ts";
import { testContext } from "../../../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  fill,
} from "../../../../../__tests__/page-helper.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../../../mocks/handlers/api-org-model-providers.ts";
import { resetMockOrgModelPolicies } from "../../../../../mocks/handlers/api-org-model-policies.ts";
import { setMockFeatureSwitches } from "../../../../../mocks/handlers/api-feature-switches.helpers.ts";
import { setCodexPasteDialogState$ } from "../../../../../signals/zero-page/settings/org-model-providers.ts";

vi.mock("@vm0/ui/components/ui/sonner", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@vm0/ui/components/ui/sonner");
  return {
    ...actual,
    toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  };
});

const context = testContext();

function makeStaleProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-0000000000a1",
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
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
    createdAt: "2026-05-06T00:00:00Z",
    updatedAt: "2026-05-06T00:00:00Z",
  };
}

function makeFreshProvider(): ModelProviderResponse {
  return {
    ...makeStaleProvider(),
    needsReconnect: false,
    lastRefreshErrorCode: null,
  };
}

function makeAnthropicProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-0000000000a2",
    type: "anthropic-api-key",
    framework: "claude-code",
    secretName: "ANTHROPIC_API_KEY",
    authMethod: null,
    secretNames: null,
    isDefault: true,
    selectedModel: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-05-06T00:00:00Z",
    updatedAt: "2026-05-06T00:00:00Z",
  };
}

beforeEach(() => {
  resetMockOrgModelProviders();
  resetMockOrgModelPolicies();
  setMockFeatureSwitches({});
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

afterEach(() => {
  context.store.set(setCodexPasteDialogState$, {
    open: false,
    mode: "connect",
  });
});

async function openProvidersPage(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=providers" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

async function findRepasteButton(): Promise<HTMLElement> {
  return await screen.findByText("Re-paste auth.json");
}

function findReconnectDialogTitle(): HTMLElement | null {
  return screen.queryByText("Re-connect Codex");
}

function getActionsButton(row: HTMLElement): HTMLElement {
  const button = within(row)
    .getAllByRole("button")
    .find((item) => {
      return /Actions for/i.test(item.getAttribute("aria-label") ?? "");
    });
  expect(button).toBeDefined();
  return button!;
}

async function openModelPolicyDialog(row: HTMLElement): Promise<HTMLElement> {
  click(getActionsButton(row));
  click(await screen.findByText("Edit model"));
  return getModelPolicyDialog();
}

function getModelPolicyDialog(): HTMLElement {
  const dialog = screen.getAllByRole("dialog").find((item) => {
    return Boolean(
      within(item).queryByText(/Choose the model members can select/i),
    );
  });
  expect(dialog).toBeDefined();
  return dialog!;
}

function getOrgProviderDialog(): HTMLElement {
  const dialog = screen.getAllByRole("dialog").find((item) => {
    return Boolean(
      within(item).queryByText(/(?:Add|Edit) workspace Anthropic/i),
    );
  });
  expect(dialog).toBeDefined();
  return dialog!;
}

function clickRouteChoice(dialog: HTMLElement, label: string): void {
  const button = within(dialog).getByText(label).closest("button");
  expect(button).toBeDefined();
  click(button!);
}

function clickDialogButton(dialog: HTMLElement, label: string): void {
  const button = within(dialog)
    .getAllByRole("button")
    .find((item) => {
      return item.textContent?.trim() === label;
    });
  expect(button).toBeDefined();
  click(button!);
}

describe("org-providers-tab — stale banner reconnect", () => {
  it("shows model policies instead of provider-row controls", async () => {
    setMockFeatureSwitches({});

    await openProvidersPage();

    await expect(
      screen.findByText(/Manage workspace models/i),
    ).resolves.toBeInTheDocument();
    expect(screen.getAllByText("Models").length).toBeGreaterThan(0);
    expect(screen.queryByText("Personal Models")).not.toBeInTheDocument();
    expect(screen.getByText("Models Configuration")).toBeInTheDocument();
    expect(screen.queryByText("Model Providers")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Members see models in this order/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Default model")).toBeInTheDocument();
    expect(
      screen.getByTestId("org-model-policy-row-claude-opus-4-7"),
    ).toHaveTextContent("Claude Opus 4.7");
    expect(
      screen.queryByText("Workspace default when no model is selected"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace default:")).not.toBeInTheDocument();
    expect(screen.queryByText("Default provider")).not.toBeInTheDocument();
  });

  it("changes the default model from the default selector", async () => {
    setMockFeatureSwitches({});

    await openProvidersPage();

    const defaultSection = (await screen.findByText("Default model")).closest(
      "section",
    );
    expect(defaultSection).toBeDefined();
    expect(
      within(defaultSection!).getByText("Claude Sonnet 4.6"),
    ).toBeDefined();

    click(within(defaultSection!).getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    click(within(listbox).getByText("Claude Opus 4.7"));

    await waitFor(() => {
      expect(
        within(defaultSection!).getByText("Claude Opus 4.7"),
      ).toBeDefined();
    });
  });

  it("adds a model from the model policy list", async () => {
    setMockFeatureSwitches({});

    await openProvidersPage();

    expect(
      screen.queryByTestId("org-model-policy-row-claude-opus-4-6"),
    ).not.toBeInTheDocument();
    click(await screen.findByText("Add model"));
    const dialog = getModelPolicyDialog();
    expect(within(dialog).getByText("Claude Opus 4.6")).toBeInTheDocument();
    click(within(dialog).getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox).queryByText("Claude Opus 4.7"),
    ).not.toBeInTheDocument();
    expect(
      within(listbox).queryByText("Claude Sonnet 4.6"),
    ).not.toBeInTheDocument();
    expect(
      within(listbox).queryByText("DeepSeek V4 Pro"),
    ).not.toBeInTheDocument();
    expect(within(listbox).getByText("Claude Opus 4.6")).toBeInTheDocument();
    click(within(listbox).getByText("Claude Opus 4.6"));
    clickDialogButton(dialog, "Add model");

    await expect(
      screen.findByTestId("org-model-policy-row-claude-opus-4-6"),
    ).resolves.toBeInTheDocument();
  });

  it("keeps the add model dialog open after closing nested API key edit", async () => {
    setMockFeatureSwitches({});
    setMockOrgModelProviders([makeAnthropicProvider()]);

    await openProvidersPage();

    click(await screen.findByText("Add model"));
    const dialog = getModelPolicyDialog();
    clickRouteChoice(dialog, "BYOK: workspace API key");
    click(within(dialog).getByText("Edit API key"));

    const providerDialog = getOrgProviderDialog();
    click(within(providerDialog).getByText("Cancel"));

    await waitFor(() => {
      expect(
        within(getModelPolicyDialog()).getByRole("heading", {
          name: "Add model",
        }),
      ).toBeInTheDocument();
      expect(
        within(getModelPolicyDialog()).getByText(
          /Choose the model members can select/i,
        ),
      ).toBeInTheDocument();
    });
  });

  it("keeps the add model dialog open after closing nested API key add", async () => {
    setMockFeatureSwitches({});

    await openProvidersPage();

    click(await screen.findByText("Add model"));
    const dialog = getModelPolicyDialog();
    clickRouteChoice(dialog, "BYOK: workspace API key");
    clickDialogButton(dialog, "Add Anthropic API key");

    const providerDialog = getOrgProviderDialog();
    click(within(providerDialog).getByText("Cancel"));

    await waitFor(() => {
      expect(
        within(getModelPolicyDialog()).getByRole("heading", {
          name: "Add model",
        }),
      ).toBeInTheDocument();
      expect(
        within(getModelPolicyDialog()).getByText(
          /Choose the model members can select/i,
        ),
      ).toBeInTheDocument();
    });
  });

  it("closes the add model dialog after nested API key add succeeds", async () => {
    setMockFeatureSwitches({});

    await openProvidersPage();

    click(await screen.findByText("Add model"));
    const dialog = getModelPolicyDialog();
    clickRouteChoice(dialog, "BYOK: workspace API key");
    clickDialogButton(dialog, "Add Anthropic API key");

    const providerDialog = getOrgProviderDialog();
    await fill(
      within(providerDialog).getByPlaceholderText("Enter your API key"),
      "sk-ant-test",
    );
    click(within(providerDialog).getByText("Add"));

    await waitFor(() => {
      expect(
        screen.queryByText(/Choose the model members can select/i),
      ).not.toBeInTheDocument();
    });
    await expect(
      screen.findByTestId("org-model-policy-row-claude-opus-4-6"),
    ).resolves.toBeInTheDocument();
  });

  it("deletes a model from the model policy list", async () => {
    setMockFeatureSwitches({});

    await openProvidersPage();

    const row = await screen.findByTestId(
      "org-model-policy-row-claude-sonnet-4-6",
    );
    click(getActionsButton(row));
    click(await screen.findByText("Delete model"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("org-model-policy-row-claude-sonnet-4-6"),
      ).not.toBeInTheDocument();
    });
  });

  it("stores OAuth routes as member credentials without token input", async () => {
    setMockFeatureSwitches({});

    await openProvidersPage();

    const row = await screen.findByTestId(
      "org-model-policy-row-claude-opus-4-7",
    );
    const dialog = await openModelPolicyDialog(row);
    clickRouteChoice(dialog, "BYOK: Claude Subscription");
    expect(
      within(dialog).queryByText("OAuth provider"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("Claude Code (OAuth token)"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText(/OAuth routes are personal/i),
    ).not.toBeInTheDocument();
    clickDialogButton(dialog, "Save changes");

    await expect(
      within(row).findByText("Claude Code (OAuth token)"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText(/Add personal Claude Code \(OAuth token\)/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("sk-ant-XXXXXXX"),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByText(/OAuth requires each member/i),
    ).not.toBeInTheDocument();
  });

  it("stores ChatGPT OAuth routes without opening paste auth", async () => {
    setMockFeatureSwitches({});

    await openProvidersPage();

    const row = await screen.findByTestId("org-model-policy-row-gpt-5.5");
    const dialog = await openModelPolicyDialog(row);
    clickRouteChoice(dialog, "BYOK: Codex Subscription");
    expect(
      within(dialog).queryByText("OAuth provider"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("ChatGPT (Codex)"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    clickDialogButton(dialog, "Save changes");

    await expect(
      within(row).findByText("ChatGPT (Codex)"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: /Connect Codex/i }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByText(/OAuth requires each member/i),
    ).not.toBeInTheDocument();
  });

  it("opens the paste dialog in reconnect mode when Re-paste button is clicked", async () => {
    setMockFeatureSwitches({});
    setMockOrgModelProviders([makeStaleProvider()]);
    await openProvidersPage();

    click(await findRepasteButton());

    await waitFor(() => {
      expect(findReconnectDialogTitle()).toBeInTheDocument();
    });
  });

  it("clears the stale banner after a successful re-paste", async () => {
    setMockFeatureSwitches({});
    setMockOrgModelProviders([makeStaleProvider()]);
    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, ({ respond }) => {
        const fresh = makeFreshProvider();
        // Reflect the post-submit state so the next list refresh sees a
        // non-stale provider; the dialog drives the refresh via the
        // internal reload counter inside submitCodexAuthJson$.
        setMockOrgModelProviders([fresh]);
        return respond(200, { provider: fresh, created: false });
      }),
    );

    await openProvidersPage();

    await waitFor(() => {
      expect(
        screen.getByText(/ChatGPT session needs reconnection/i),
      ).toBeInTheDocument();
    });

    click(await findRepasteButton());

    await fill(
      await screen.findByTestId("codex-paste-textarea"),
      '{"OPENAI_API_KEY":"sk","tokens":{"access_token":"a"}}',
    );
    click(screen.getByTestId("codex-paste-submit"));

    await waitFor(() => {
      expect(
        screen.queryByText(/ChatGPT session needs reconnection/i),
      ).not.toBeInTheDocument();
    });
    expect(findReconnectDialogTitle()).not.toBeInTheDocument();
  });
});
