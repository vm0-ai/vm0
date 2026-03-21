import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ModelProviderResponse } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

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
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "prov-2",
      type: "openrouter-api-key",
      framework: "claude-code",
      secretName: "OPENROUTER_API_KEY",
      authMethod: null,
      secretNames: null,
      isDefault: false,
      selectedModel: null,
      createdAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    },
  ];
}

function mockProvidersAPI(providers = createMockProviders()) {
  server.use(
    http.get("*/api/zero/model-providers", () => {
      return HttpResponse.json({ modelProviders: providers });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockNonAdmin() {
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

describe("zero settings page - admin rendering", () => {
  it("should render page header with title and description", async () => {
    mockProvidersAPI();
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

  it("should render configured provider cards", async () => {
    mockProvidersAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Model providers")).toBeInTheDocument();
    });

    const configuredLabels = screen.getAllByText("Configured");
    expect(configuredLabels).toHaveLength(2);
  });

  it("should show Add provider button when not all types are configured", async () => {
    mockProvidersAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Add provider")).toBeInTheDocument();
    });
  });

  it("should show More options button on each provider card", async () => {
    mockProvidersAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Model providers")).toBeInTheDocument();
    });

    const moreButtons = screen.getAllByRole("button", {
      name: "More options",
    });
    expect(moreButtons).toHaveLength(2);
  });
});

describe("zero settings page - default provider selector", () => {
  it("should render default provider section for admin", async () => {
    mockProvidersAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Default model provider")).toBeInTheDocument();
    });
    expect(screen.getByText("Default provider")).toBeInTheDocument();
  });

  it("should show No providers configured when provider list is empty", async () => {
    mockProvidersAPI([]);
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("No providers configured")).toBeInTheDocument();
    });
  });
});

describe("zero settings page - non-admin rendering", () => {
  it("should not show Add provider button for non-admin", async () => {
    mockNonAdmin();
    mockProvidersAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Anthropic API key")).toBeInTheDocument();
    });

    expect(screen.queryByText("Add provider")).not.toBeInTheDocument();
  });

  it("should not show dropdown menus for non-admin", async () => {
    mockNonAdmin();
    mockProvidersAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Anthropic API key")).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("button", { name: "More options" }),
    ).not.toBeInTheDocument();
  });

  it("should not show default provider selector for non-admin", async () => {
    mockNonAdmin();
    mockProvidersAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Anthropic API key")).toBeInTheDocument();
    });

    expect(
      screen.queryByText("Default model provider"),
    ).not.toBeInTheDocument();
  });

  it("should show empty state message for non-admin when no providers", async () => {
    mockNonAdmin();
    mockProvidersAPI([]);
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
    mockProvidersAPI();
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
    mockProvidersAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Model providers")).toBeInTheDocument();
    });

    // Provider cards have role="button" for admins — find by the "Configured" status
    // which is unique to provider cards (not in sidebar)
    const configuredLabels = screen.getAllByText("Configured");
    // Click the parent card (the role="button" div) of the first provider
    const firstProviderCard = configuredLabels[0].closest("[role='button']");
    expect(firstProviderCard).toBeTruthy();
    fireEvent.click(firstProviderCard!);

    await waitFor(() => {
      expect(
        screen.getByText(/Edit organization Anthropic API key/),
      ).toBeInTheDocument();
    });
  });
});

describe("zero settings page - dropdown menu interaction", () => {
  it("should open dropdown menu with Edit and Delete items on pointer down", async () => {
    mockProvidersAPI();
    await renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByText("Model providers")).toBeInTheDocument();
    });

    const moreButtons = screen.getAllByRole("button", {
      name: "More options",
    });

    // Radix DropdownMenu uses pointerdown to open
    fireEvent.pointerDown(moreButtons[0], {
      button: 0,
      ctrlKey: false,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("menuitem", { name: "Edit" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("menuitem", { name: "Delete" }),
    ).toBeInTheDocument();
  });
});
