/**
 * Tests for OrgProvidersTab — specifically the stale-session reconnect
 * banner button.
 *
 * Covers:
 * - Reconnect button opens the Codex device login dialog with reconnect title
 * - Successful reconnect clears needsReconnect → banner unmounts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { server } from "../../../../../mocks/server.ts";
import { mockApi } from "../../../../../mocks/msw-contract.ts";
import { testContext } from "../../../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
} from "../../../../../__tests__/page-helper.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../../../mocks/handlers/api-org-model-providers.ts";
import { resetMockOrgModelPolicies } from "../../../../../mocks/handlers/api-org-model-policies.ts";
import { setMockFeatureSwitches } from "../../../../../mocks/handlers/api-feature-switches.helpers.ts";

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

async function openProvidersPage(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=providers" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

async function findReconnectButton(): Promise<HTMLElement> {
  return await screen.findByText("Reconnect");
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
      within(item).queryByText(/Decide how members access this model/i),
    );
  });
  expect(dialog).toBeDefined();
  return dialog!;
}

function openLabeledSelect(
  dialog: HTMLElement,
  labelText: string,
): HTMLElement {
  const label = within(dialog).getByText(labelText);
  const container = label.parentElement;
  expect(container).toBeTruthy();
  const trigger = within(container!).getByRole("combobox");
  click(trigger);
  return trigger;
}

function clickRouteChoice(dialog: HTMLElement, label: string): void {
  const button = within(dialog).getByText(label).closest("button");
  expect(button).toBeDefined();
  click(button!);
}

function getDialogButton(dialog: HTMLElement, label: string): HTMLElement {
  const button = within(dialog)
    .getAllByRole("button")
    .find((item) => {
      return item.textContent?.trim() === label;
    });
  expect(button).toBeDefined();
  return button!;
}

function clickDialogButton(dialog: HTMLElement, label: string): void {
  click(getDialogButton(dialog, label));
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
    expect(within(defaultSection!).getByText("DeepSeek V4 Pro")).toBeDefined();

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
    openLabeledSelect(dialog, "Model");
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

  it("shows a masked api key when editing a model whose key is already configured", async () => {
    setMockFeatureSwitches({});
    setMockOrgModelProviders([makeAnthropicProvider()]);

    await openProvidersPage();

    click(await screen.findByText("Add model"));
    const dialog = getModelPolicyDialog();
    clickRouteChoice(dialog, "API key");

    const input = within(dialog).getByPlaceholderText("Enter your API key");
    expect((input as HTMLInputElement).value).not.toBe("");
    expect((input as HTMLInputElement).value).not.toBe("sk-ant-test");
  });

  it("closes the add model dialog after inline API key save succeeds", async () => {
    setMockFeatureSwitches({});
    let submittedSecret: string | undefined;
    const upsertControl: { resolve?: () => void } = {};
    server.use(
      mockApi(
        zeroModelProvidersMainContract.upsert,
        async ({ body, deferred, respond }) => {
          submittedSecret = body.secret;
          const upsertGate = deferred<void>();
          upsertControl.resolve = () => {
            upsertGate.resolve();
          };
          await upsertGate.promise;
          const provider = {
            ...makeAnthropicProvider(),
            id: "00000000-0000-4000-a000-0000000000b2",
            isDefault: false,
          };
          setMockOrgModelProviders([provider]);
          return respond(201, { provider, created: true });
        },
      ),
    );

    await openProvidersPage();

    click(await screen.findByText("Add model"));
    const dialog = getModelPolicyDialog();
    clickRouteChoice(dialog, "API key");
    const input = within(dialog).getByPlaceholderText("Enter your API key");
    fireEvent.change(input, { target: { value: " sk-ant\n test " } });
    clickDialogButton(dialog, "Add model");
    const cancelButton = getDialogButton(dialog, "Cancel");

    await waitFor(() => {
      expect(submittedSecret).toBe("sk-anttest");
      expect(cancelButton).toBeDisabled();
    });
    click(cancelButton);
    expect(
      screen.getByText(/Decide how members access this model/i),
    ).toBeInTheDocument();
    const resolveUpsert = upsertControl.resolve;
    if (!resolveUpsert) {
      throw new Error("Expected inline API key request to start");
    }
    resolveUpsert();

    await waitFor(() => {
      expect(
        screen.queryByText(/Decide how members access this model/i),
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
    clickRouteChoice(dialog, "Claude subscription");
    expect(
      within(dialog).queryByText("OAuth provider"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("Claude Code (OAuth token)"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Provider")).not.toBeInTheDocument();
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
    clickRouteChoice(dialog, "Codex subscription");
    expect(
      within(dialog).queryByText("OAuth provider"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("ChatGPT (Codex)"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Provider")).not.toBeInTheDocument();
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

  it("opens the device login dialog in reconnect mode when Reconnect is clicked", async () => {
    setMockFeatureSwitches({});
    setMockOrgModelProviders([makeStaleProvider()]);
    await openProvidersPage();

    click(await findReconnectButton());

    await waitFor(() => {
      expect(findReconnectDialogTitle()).toBeInTheDocument();
    });
    expect(screen.getByTestId("codex-device-auth-start")).toBeInTheDocument();
    expect(screen.getByText("Reconnect ChatGPT")).toBeInTheDocument();
  });

  it("clears the stale banner after a successful reconnect", async () => {
    setMockFeatureSwitches({});
    setMockOrgModelProviders([makeStaleProvider()]);
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
        const fresh = makeFreshProvider();
        setMockOrgModelProviders([fresh]);
        return respond(200, {
          status: "complete",
          created: false,
          provider: fresh,
        });
      }),
    );

    await openProvidersPage();

    await waitFor(() => {
      expect(
        screen.getByText(/ChatGPT session needs reconnection/i),
      ).toBeInTheDocument();
    });

    click(await findReconnectButton());
    click(await screen.findByTestId("codex-device-auth-start"));

    await waitFor(() => {
      expect(
        screen.queryByText(/ChatGPT session needs reconnection/i),
      ).not.toBeInTheDocument();
    });
    expect(findReconnectDialogTitle()).not.toBeInTheDocument();
  });
});
