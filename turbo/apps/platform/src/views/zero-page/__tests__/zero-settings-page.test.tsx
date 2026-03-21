import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type { ModelProviderResponse } from "@vm0/core";

const context = testContext();

function createMockProviders(): ModelProviderResponse[] {
  return [
    {
      id: "prov-1",
      type: "anthropic-api-key",
      framework: "claude-code",
      secretName: "ANTHROPIC_API_KEY",
      authMethod: null,
      secretNames: null,
      isDefault: true,
      selectedModel: null,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    },
    {
      id: "prov-2",
      type: "openrouter-api-key",
      framework: "claude-code",
      secretName: "OPENROUTER_API_KEY",
      authMethod: null,
      secretNames: null,
      isDefault: false,
      selectedModel: "anthropic/claude-sonnet-4.5",
      createdAt: "2026-03-02T00:00:00Z",
      updatedAt: "2026-03-02T00:00:00Z",
    },
  ];
}

function mockProviderAPI(providers = createMockProviders()) {
  server.use(
    http.get("*/api/zero/model-providers", () => {
      return HttpResponse.json({ modelProviders: providers });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockMemberRole() {
  server.use(
    http.get("*/api/zero/org", () => {
      return HttpResponse.json({
        id: "org_1",
        slug: "user-12345678",
        role: "member",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function renderSettingsPage() {
  await setupPage({ context, path: "/settings" });
}

describe("zero settings page - admin view", () => {
  it("should render page header with title and description", async () => {
    mockProviderAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Settings", level: 1 }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText("Configure model providers for your agents."),
    ).toBeInTheDocument();
  });

  it("should render default provider section for admin", async () => {
    mockProviderAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Default model provider")).toBeInTheDocument();
    });
    expect(screen.getByText("Default provider")).toBeInTheDocument();
  });

  it("should render provider cards with configured status", async () => {
    mockProviderAPI();
    await renderSettingsPage();

    await waitFor(() => {
      const configuredLabels = screen.getAllByText("Configured");
      expect(configuredLabels).toHaveLength(2);
    });
  });

  it("should render model providers section heading", async () => {
    mockProviderAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Model providers")).toBeInTheDocument();
    });
  });

  it("should show add provider button when not all types are configured", async () => {
    mockProviderAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Add provider")).toBeInTheDocument();
    });
  });

  it("should show more options menu button on each provider card", async () => {
    mockProviderAPI();
    await renderSettingsPage();

    await waitFor(() => {
      const moreButtons = screen.getAllByRole("button", {
        name: "More options",
      });
      expect(moreButtons).toHaveLength(2);
    });
  });

  it("should show no providers configured when provider list is empty", async () => {
    mockProviderAPI([]);
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("No providers configured")).toBeInTheDocument();
    });
  });
});

describe("zero settings page - member view", () => {
  it("should not render default provider section for non-admin", async () => {
    mockMemberRole();
    mockProviderAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Model providers")).toBeInTheDocument();
    });

    expect(
      screen.queryByText("Default model provider"),
    ).not.toBeInTheDocument();
  });

  it("should not show add provider button for non-admin", async () => {
    mockMemberRole();
    mockProviderAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Model providers")).toBeInTheDocument();
    });

    expect(screen.queryByText("Add provider")).not.toBeInTheDocument();
  });

  it("should not show more options menu for non-admin", async () => {
    mockMemberRole();
    mockProviderAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getAllByText("Configured").length).toBeGreaterThanOrEqual(
        1,
      );
    });

    expect(
      screen.queryByRole("button", { name: "More options" }),
    ).not.toBeInTheDocument();
  });

  it("should show empty state message when no providers for member", async () => {
    mockMemberRole();
    mockProviderAPI([]);
    await renderSettingsPage();

    await waitFor(() => {
      expect(
        screen.getByText(
          "No organization providers have been configured yet. Contact your admin to set up model providers.",
        ),
      ).toBeInTheDocument();
    });
  });
});

describe("zero settings page - add provider dialog", () => {
  it("should open add provider dialog when Add provider is clicked", async () => {
    mockProviderAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Add provider")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Add provider"));

    await waitFor(() => {
      expect(
        screen.getByText("Add organization model provider"),
      ).toBeInTheDocument();
    });
  });
});

describe("zero settings page - edit provider", () => {
  it("should open edit dialog when clicking a provider card", async () => {
    mockProviderAPI();
    await renderSettingsPage();

    // Wait for provider cards to render by checking for "Configured" status
    await waitFor(() => {
      expect(screen.getAllByText("Configured")).toHaveLength(2);
    });

    // Find the provider card div with role="button" — it contains the provider name
    // The card div has role="button" and class="zero-card" for admins
    const providerCardButtons = screen
      .getAllByRole("button")
      .filter(
        (el) =>
          el.classList.contains("zero-card") &&
          el.textContent?.includes("Anthropic API key"),
      );
    expect(providerCardButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(providerCardButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText("Edit organization Anthropic API key"),
      ).toBeInTheDocument();
    });
  });
});

describe("zero settings page - delete provider", () => {
  it("should open delete confirmation dialog from dropdown menu", async () => {
    mockProviderAPI();
    await renderSettingsPage();

    // Wait for provider cards to render
    await waitFor(() => {
      expect(screen.getAllByText("Configured")).toHaveLength(2);
    });

    // Open the dropdown menu — Radix DropdownMenu needs pointerDown to trigger
    const moreButtons = screen.getAllByRole("button", {
      name: "More options",
    });
    fireEvent.pointerDown(moreButtons[0], {
      button: 0,
      ctrlKey: false,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("menuitem", { name: "Delete" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Are you sure you want to delete this organization model provider?",
        ),
      ).toBeInTheDocument();
    });
  });
});
