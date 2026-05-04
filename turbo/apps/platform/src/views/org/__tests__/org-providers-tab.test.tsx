/**
 * Tests for OrgProvidersTab, OrgAddProviderDialog, and OrgDeleteProviderDialog.
 *
 * Entry point: setupPage({ path: "/?settings=providers" })
 * External mocks: MSW for HTTP endpoints
 * Internal: real signals, components, rendering
 */

import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  type ModelProviderResponse,
  MODEL_PROVIDER_TYPES,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  zeroModelProvidersDefaultContract,
  zeroModelProvidersByTypeContract,
} from "@vm0/api-contracts/contracts/zero-model-providers";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setMockOrg, resetMockOrg } from "../../../mocks/handlers/api-org.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

function makeProvider(
  type: ModelProviderResponse["type"],
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000001",
    type,
    framework: "claude-code",
    secretName: "ANTHROPIC_API_KEY",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetMockOrg();
  resetMockOrgModelProviders();
});

function mockAPIs(options?: {
  providers?: ModelProviderResponse[];
  role?: "admin" | "member";
}) {
  const role = options?.role ?? "admin";
  setMockOrg({ id: "org_1", slug: "user-12345678", name: "Test Org", role });
  setMockOrgModelProviders(options?.providers ?? []);
}

async function openProvidersPage() {
  detachedSetupPage({
    context,
    path: "/?settings=providers",
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("org providers tab - display", () => {
  // ORG-D-065
  it("shows provider icon, label, and configured status for each provider", async () => {
    mockAPIs({
      providers: [makeProvider("anthropic-api-key", { isDefault: true })],
    });
    await openProvidersPage();
    await waitFor(() => {
      expect(screen.getAllByText("Anthropic").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("Configured")).toBeInTheDocument();
    const imgs = document.querySelectorAll("img[alt='']");
    expect(imgs.length).toBeGreaterThan(0);
  });

  // ORG-D-066
  it("shows configured status indicator for configured providers", async () => {
    mockAPIs({
      providers: [makeProvider("anthropic-api-key", { isDefault: true })],
    });
    await openProvidersPage();
    await waitFor(() => {
      expect(screen.getByText("Configured")).toBeInTheDocument();
    });
  });

  // ORG-D-067
  it("shows current default provider in the default provider select dropdown", async () => {
    mockAPIs({
      providers: [makeProvider("anthropic-api-key", { isDefault: true })],
    });
    await openProvidersPage();
    await waitFor(() => {
      // The default provider select shows the current default value
      // Multiple comboboxes may exist (tab nav + default provider select)
      const comboboxes = screen.getAllByRole("combobox");
      const defaultSelect = comboboxes.find((el) => {
        return el.textContent?.includes("Anthropic");
      });
      expect(defaultSelect).toBeInTheDocument();
    });
  });

  // ORG-C-068
  it("shows no providers configured message when provider list is empty (admin)", async () => {
    mockAPIs({ providers: [] });
    await openProvidersPage();
    await waitFor(() => {
      expect(screen.getByText("No providers configured")).toBeInTheDocument();
    });
  });

  it("does not show the VM0 model popularity ranking entry point", async () => {
    mockAPIs({
      providers: [makeProvider("anthropic-api-key", { isDefault: true })],
    });
    await openProvidersPage();
    await waitFor(() => {
      expect(screen.getByText("Default provider")).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText("Open VM0 model popularity ranking"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Model Popularity")).not.toBeInTheDocument();
    expect(screen.queryByText("LLM Leaderboard")).not.toBeInTheDocument();
  });
});

describe("org providers tab - interaction", () => {
  // ORG-I-069
  it("opens add provider dialog when add provider button is clicked", async () => {
    mockAPIs({ providers: [] });
    await openProvidersPage();
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /add provider/i.test(el.textContent ?? "");
        }),
      ).toBeDefined();
    });
    const addProviderBtn1 = screen.getAllByRole("button").find((el) => {
      return /add provider/i.test(el.textContent ?? "");
    });
    expect(addProviderBtn1).toBeDefined();
    click(addProviderBtn1!);
    await waitFor(() => {
      expect(
        screen.getByText("Add workspace model provider"),
      ).toBeInTheDocument();
    });
  });

  // ORG-I-070
  it("opens edit dialog when provider card is clicked by admin", async () => {
    mockAPIs({
      providers: [makeProvider("anthropic-api-key", { isDefault: true })],
    });
    await openProvidersPage();
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /Anthropic/i.test(el.textContent ?? "");
        }),
      ).toBeDefined();
    });
    const anthropicBtn = screen.getAllByRole("button").find((el) => {
      return /Anthropic/i.test(el.textContent ?? "");
    });
    expect(anthropicBtn).toBeDefined();
    click(anthropicBtn!);
    await waitFor(() => {
      expect(screen.getByText(/Edit workspace Anthropic/i)).toBeInTheDocument();
    });
  });

  // ORG-I-071
  it("updates default provider when select dropdown value is changed", async () => {
    let capturedDefaultType: string | null = null;
    mockAPIs({
      providers: [
        makeProvider("anthropic-api-key", { isDefault: true }),
        makeProvider("openrouter-api-key", {
          id: "00000000-0000-4000-a000-000000000002",
          isDefault: false,
        }),
      ],
    });
    server.use(
      mockApi(
        zeroModelProvidersDefaultContract.setDefault,
        ({ params, respond }) => {
          capturedDefaultType = params.type;
          return respond(
            200,
            makeProvider(params.type as ModelProviderResponse["type"], {
              isDefault: true,
            }),
          );
        },
      ),
    );
    await openProvidersPage();
    await waitFor(() => {
      // Find the default provider select (shows "Anthropic"), not the tab nav select
      const comboboxes = screen.getAllByRole("combobox");
      const defaultSelect = comboboxes.find((el) => {
        return el.textContent?.includes("Anthropic");
      });
      expect(defaultSelect).toBeInTheDocument();
    });
    const comboboxes = screen.getAllByRole("combobox");
    const defaultSelect = comboboxes.find((el) => {
      return el.textContent?.includes("Anthropic");
    })!;
    click(defaultSelect);
    await waitFor(() => {
      expect(screen.getAllByText("OpenRouter").length).toBeGreaterThan(0);
    });
    // Click the select option (not the provider card that also shows "OpenRouter")
    const openRouterOptions = screen.getAllByText("OpenRouter");
    const selectOption = openRouterOptions[openRouterOptions.length - 1];
    click(selectOption);
    await waitFor(() => {
      expect(capturedDefaultType).toBe("openrouter-api-key");
    });
  });

  // ORG-I-072
  it("shows edit and delete options in provider action menu", async () => {
    mockAPIs({
      providers: [makeProvider("anthropic-api-key", { isDefault: true })],
    });
    await openProvidersPage();
    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });
    const moreOptionsBtn1 = screen.getByLabelText("More options");
    click(moreOptionsBtn1);
    await waitFor(() => {
      expect(screen.getByText("Edit")).toBeInTheDocument();
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });
  });
});

describe("org add provider dialog - display", () => {
  // ORG-D-082
  it("shows provider cards with icon and label in add dialog", async () => {
    mockAPIs({ providers: [] });
    await openProvidersPage();
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /add provider/i.test(el.textContent ?? "");
        }),
      ).toBeDefined();
    });
    const addProviderBtn2 = screen.getAllByRole("button").find((el) => {
      return /add provider/i.test(el.textContent ?? "");
    });
    expect(addProviderBtn2).toBeDefined();
    click(addProviderBtn2!);
    await waitFor(() => {
      expect(
        screen.getByText("Add workspace model provider"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("org-provider-card-anthropic-api-key"),
    ).toBeInTheDocument();
  });

  // ORG-C-084
  it("hides add provider button when all providers are configured", async () => {
    const allTypes = Object.keys(
      MODEL_PROVIDER_TYPES,
    ) as ModelProviderResponse["type"][];
    const allProviders = allTypes.map((type, idx) => {
      return makeProvider(type, {
        id: `00000000-0000-4000-a000-${String(idx).padStart(12, "0")}`,
        isDefault: idx === 0,
      });
    });
    mockAPIs({ providers: allProviders });
    await openProvidersPage();
    await waitFor(() => {
      expect(
        screen.queryAllByRole("button").find((el) => {
          return /add provider/i.test(el.textContent ?? "");
        }),
      ).toBeUndefined();
    });
  });
});

describe("org add provider dialog - interaction", () => {
  // ORG-I-085
  it("triggers add flow when provider card is clicked", async () => {
    mockAPIs({ providers: [] });
    await openProvidersPage();
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /add provider/i.test(el.textContent ?? "");
        }),
      ).toBeDefined();
    });
    const addProviderBtn3 = screen.getAllByRole("button").find((el) => {
      return /add provider/i.test(el.textContent ?? "");
    });
    expect(addProviderBtn3).toBeDefined();
    click(addProviderBtn3!);
    await waitFor(() => {
      expect(
        screen.getByTestId("org-provider-card-anthropic-api-key"),
      ).toBeInTheDocument();
    });
    click(screen.getByTestId("org-provider-card-anthropic-api-key"));
    await waitFor(() => {
      expect(screen.getByText(/Add workspace Anthropic/i)).toBeInTheDocument();
    });
  });
});

describe("org delete provider dialog - display", () => {
  // ORG-D-086
  it("shows confirmation message and consequences description", async () => {
    mockAPIs({
      providers: [makeProvider("anthropic-api-key", { isDefault: true })],
    });
    await openProvidersPage();
    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });
    const moreOptionsBtn2 = screen.getByLabelText("More options");
    click(moreOptionsBtn2);
    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });
    click(screen.getByText("Delete"));
    await waitFor(() => {
      expect(
        screen.getByText(
          /Are you sure you want to delete this workspace model provider\?/i,
        ),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/This will remove the workspace provider/i),
    ).toBeInTheDocument();
  });
});

async function openDeleteDialog() {
  await waitFor(() => {
    expect(screen.getByLabelText("More options")).toBeInTheDocument();
  });
  const moreOptionsBtn = screen.getByLabelText("More options");
  click(moreOptionsBtn);
  await waitFor(() => {
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });
  click(screen.getByText("Delete"));
  await waitFor(() => {
    expect(
      screen.getByText(
        /Are you sure you want to delete this workspace model provider\?/i,
      ),
    ).toBeInTheDocument();
  });
}

describe("org delete provider dialog - interaction", () => {
  // ORG-I-087
  it("closes dialog when cancel button is clicked", async () => {
    mockAPIs({
      providers: [makeProvider("anthropic-api-key", { isDefault: true })],
    });
    await openProvidersPage();
    await openDeleteDialog();
    const cancelBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Cancel";
    });
    expect(cancelBtn).toBeDefined();
    click(cancelBtn!);
    await waitFor(() => {
      expect(
        screen.queryByText(
          /Are you sure you want to delete this workspace model provider\?/i,
        ),
      ).not.toBeInTheDocument();
    });
  });

  // ORG-I-088
  it("shows Deleting... state and calls delete endpoint when delete button is clicked", async () => {
    const deleteDeferred = createDeferredPromise<void>(context.signal);

    mockAPIs({
      providers: [makeProvider("anthropic-api-key", { isDefault: true })],
    });
    server.use(
      mockApi(zeroModelProvidersByTypeContract.delete, async ({ respond }) => {
        await deleteDeferred.promise;
        return respond(204);
      }),
    );
    await openProvidersPage();
    await openDeleteDialog();
    const deleteBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Delete";
    });
    expect(deleteBtn).toBeDefined();
    click(deleteBtn!);
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Deleting...";
        }),
      ).toBeDefined();
    });
    deleteDeferred.resolve();
    await deleteDeferred.promise;
  });
});
