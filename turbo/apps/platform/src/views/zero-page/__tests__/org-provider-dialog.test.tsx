/**
 * Tests for OrgProviderDialog, provider-dialog-fields, and provider-icons.
 *
 * Tests page-level behavior via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/?settings=providers" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import {
  orgOpenAddDialog$,
  orgOpenEditDialog$,
  setOrgAddProviderDialogOpen$,
} from "../../../signals/zero-page/settings/org-model-providers.ts";
import { setOrgManageDialogOpen$ } from "../../../signals/zero-page/settings/org-manage-dialog.ts";
import { setActiveOrgManageTab$ } from "../../../signals/zero-page/settings/org-manage-tabs-state.ts";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

async function openProvidersPage() {
  detachedSetupPage({ context, path: "/" });
  context.store.set(setActiveOrgManageTab$, "providers");
  await context.store.set(setOrgManageDialogOpen$, true, context.signal);
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

async function openAddDialog(
  providerType: ModelProviderResponse["type"],
  waitText: RegExp | string,
) {
  await openProvidersPage();
  context.store.set(orgOpenAddDialog$, providerType);
  await waitFor(() => {
    expect(screen.getByText(waitText)).toBeInTheDocument();
  });
}

async function openEditDialog(
  provider: ModelProviderResponse,
  waitText: RegExp | string,
) {
  await openProvidersPage();
  context.store.set(orgOpenEditDialog$, provider);
  await waitFor(() => {
    expect(screen.getByText(waitText)).toBeInTheDocument();
  });
}

function mockProviderResponse(
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000001",
    type: "anthropic-api-key",
    framework: "claude-code",
    secretName: "ANTHROPIC_API_KEY",
    authMethod: null,
    secretNames: null,
    isDefault: true,
    selectedModel: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("org-provider-dialog - display", () => {
  // ORG-D-089: dialog title and description based on mode/type
  it("shows add title for anthropic-api-key in add mode", async () => {
    await openAddDialog("anthropic-api-key", /Add workspace Anthropic/i);
    expect(screen.getByText(/Add workspace Anthropic/i)).toBeInTheDocument();
  });

  it("shows edit title for anthropic-api-key in edit mode", async () => {
    const provider = mockProviderResponse({ type: "anthropic-api-key" });
    await openEditDialog(provider, /Edit workspace Anthropic/i);
    expect(screen.getByText(/Edit workspace Anthropic/i)).toBeInTheDocument();
  });

  it("shows multi-auth title for aws-bedrock in add mode", async () => {
    await openAddDialog("aws-bedrock", /Add AWS Bedrock provider/i);
    expect(screen.getByText(/Add AWS Bedrock provider/i)).toBeInTheDocument();
  });

  // ORG-D-103: provider icon renders correct image by type
  it("renders img elements for known provider types in add-provider list", async () => {
    await openProvidersPage();
    context.store.set(setOrgAddProviderDialogOpen$, true);

    await waitFor(() => {
      const imgs = document.querySelectorAll("img[alt='']");
      expect(imgs.length).toBeGreaterThan(0);
    });

    const imgs = document.querySelectorAll("img[alt='']");
    expect(imgs.length).toBeGreaterThan(0);
  });

  // ORG-D-104: default fallback icon is rendered for unknown type
  it("does not render fallback SVG path for known provider types", async () => {
    await openProvidersPage();
    context.store.set(setOrgAddProviderDialogOpen$, true);

    await waitFor(() => {
      const imgs = document.querySelectorAll("img[alt='']");
      expect(imgs.length).toBeGreaterThan(0);
    });

    // The fallback SVG contains the path "M12 2C6.48 2" — none of the known providers should show this
    const svgPaths = document.querySelectorAll("path[d^='M12 2C6.48']");
    expect(svgPaths).toHaveLength(0);
  });
});

describe("org-provider-dialog - content", () => {
  // ORG-C-090: form fields vary based on provider shape
  it("renders secret input field for claude-code-oauth-token provider", async () => {
    await openAddDialog("claude-code-oauth-token", /Add workspace/i);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    // oauth shape should NOT show auth method selector
    expect(
      screen.queryByText("Select authentication method"),
    ).not.toBeInTheDocument();
  });

  it("renders api key field without auth method selector for anthropic-api-key provider", async () => {
    await openAddDialog("anthropic-api-key", /Add workspace/i);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    // api-key shape should NOT show auth method selector
    expect(
      screen.queryByText("Select authentication method"),
    ).not.toBeInTheDocument();
  });

  it("renders auth method selector for aws-bedrock multi-auth provider", async () => {
    await openAddDialog("aws-bedrock", /Add AWS Bedrock provider/i);
    expect(
      screen.getByText("Select authentication method"),
    ).toBeInTheDocument();
  });

  it("does not render provider-level model selector for vm0 provider", async () => {
    await openAddDialog("vm0", /Add workspace/i);
    // Workspace model choice now lives in model policies, not provider rows.
    expect(screen.queryByText("Select model")).not.toBeInTheDocument();
    expect(screen.queryByText("API key")).not.toBeInTheDocument();
  });
});

describe("org-provider-dialog - interaction", () => {
  // ORG-I-092: secret input fields accept values
  it("accepts typed value in secret input for anthropic-api-key", async () => {
    const user = userEvent.setup();
    await openAddDialog("anthropic-api-key", /Add workspace/i);

    const input = screen.getByPlaceholderText("Enter your API key");
    await user.type(input, "sk-ant-my-secret-key");

    expect(input).toHaveValue("sk-ant-my-secret-key");
  });

  it("does not render provider-level model selector for openrouter provider", async () => {
    await openAddDialog("openrouter-api-key", /Add workspace/i);

    expect(
      screen.getByPlaceholderText("Enter your API key"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Select model")).not.toBeInTheDocument();
  });

  // ORG-I-094: auth method selector for multi-auth providers
  it("shows auth method options for aws-bedrock multi-auth provider", async () => {
    await openAddDialog("aws-bedrock", /Add AWS Bedrock provider/i);

    expect(
      screen.getByText("Select authentication method"),
    ).toBeInTheDocument();

    const trigger = screen.getByRole("combobox");
    click(trigger);

    await waitFor(() => {
      expect(screen.getAllByText("Bedrock API key").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("IAM access keys")).toBeInTheDocument();
  });

  it("does not render provider-level default model toggle for azure-foundry", async () => {
    await openAddDialog("azure-foundry", /Add Azure foundry portal provider/i);

    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("does not render provider-level custom model input for azure-foundry", async () => {
    await openAddDialog("azure-foundry", /Add Azure foundry portal provider/i);

    expect(
      screen.queryByPlaceholderText("claude-sonnet-4-5"),
    ).not.toBeInTheDocument();
  });

  // ORG-I-097: cancel button closes dialog
  it("closes dialog when cancel button is clicked", async () => {
    await openAddDialog("anthropic-api-key", /Add workspace/i);

    expect(screen.getByText(/Add workspace Anthropic/i)).toBeInTheDocument();

    click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(
        screen.queryByText(/Add workspace Anthropic/i),
      ).not.toBeInTheDocument();
    });
  });

  // ORG-I-098: add/save button submits form with loading state
  it("shows loading state when add button is clicked with valid input", async () => {
    const user = userEvent.setup();

    const postDeferred = createDeferredPromise<void>(context.signal);

    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, async ({ respond }) => {
        await postDeferred.promise;
        return respond(201, {
          provider: mockProviderResponse({ type: "anthropic-api-key" }),
          created: true,
        });
      }),
    );

    await openAddDialog("anthropic-api-key", /Add workspace/i);

    const input = screen.getByPlaceholderText("Enter your API key");
    await user.type(input, "sk-ant-some-key-value");

    const addButton = screen.getByText("Add");
    click(addButton);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /^(Add|Saving)/i.test(el.textContent?.trim() ?? "");
        })!,
      ).toBeDisabled();
    });

    // Resolve the deferred POST so nothing leaks into next tests
    postDeferred.resolve();
    await postDeferred.promise;
  });
});

describe("org-provider-dialog - validation", () => {
  // ORG-D-091 / ORG-V-102: form field validation errors are displayed
  it("shows api key required error when submitting empty form for anthropic-api-key", async () => {
    await openAddDialog("anthropic-api-key", /Add workspace/i);

    click(screen.getByText("Add"));

    await waitFor(() => {
      expect(screen.getByText("API key is required")).toBeInTheDocument();
    });
  });
});
