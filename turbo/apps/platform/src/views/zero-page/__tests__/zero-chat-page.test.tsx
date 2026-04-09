import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import { getCategories } from "../zero-ideation-data.ts";

const context = testContext();

function mockChatAPI() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function renderChatPage() {
  mockChatAPI();
  await setupPage({ context, path: "/" });
}

describe("zero chat page - suggested prompts", () => {
  const allUseCases = getCategories().flatMap((c) => {
    return c.cases;
  });
  const allTitles = new Set(
    allUseCases.map((u) => {
      return u.title;
    }),
  );
  const promptByTitle = new Map(
    allUseCases.map((u) => {
      return [u.title, u.prompt];
    }),
  );

  it("should render suggested prompt cards from the use case dataset", async () => {
    await renderChatPage();

    const exploreText = await waitFor(() => {
      return screen.getByText(/Ideas & use cases/);
    });
    expect(exploreText).toBeInTheDocument();

    // The prompt grid is the grandparent: <p> → <button> → <div.grid>
    const promptGrid = exploreText.closest("button")!.parentElement!;
    const gridButtons = within(promptGrid).getAllByRole("button");

    // 2 random prompt cards + 1 "Ideas & use cases" card
    expect(gridButtons).toHaveLength(3);

    // Each random card title should come from the known dataset
    for (const button of gridButtons) {
      const text = button.textContent ?? "";
      if (text.includes("Ideas & use cases")) {
        continue;
      }
      const matchesDataset = allUseCases.some((u) => {
        return text.includes(u.title);
      });
      expect(matchesDataset).toBeTruthy();
    }
  });

  it("should populate composer with the correct prompt when a card is clicked", async () => {
    const user = userEvent.setup();
    await renderChatPage();

    const exploreText = await waitFor(() => {
      return screen.getByText(/Ideas & use cases/);
    });
    const promptGrid = exploreText.closest("button")!.parentElement!;
    const gridButtons = within(promptGrid).getAllByRole("button");

    // Find the first random prompt card (not "Ideas & use cases")
    const promptCard = gridButtons.find((btn) => {
      return !btn.textContent?.includes("Ideas & use cases");
    })!;

    // Identify which use case this card represents
    const cardTitle = [...allTitles].find((title) => {
      return promptCard.textContent?.includes(title);
    })!;
    const expectedPrompt = promptByTitle.get(cardTitle)!;

    await user.click(promptCard);

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText(
        "Ask me to automate workflows, manage tasks...",
      );
      expect(textarea).toHaveValue(expectedPrompt);
    });
  });
});

describe("zero chat page - composer", () => {
  it("should render composer textarea", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(
          "Ask me to automate workflows, manage tasks...",
        ),
      ).toBeInTheDocument();
    });
  });

  it("should render Send button", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });

  it("should render Attach button", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByLabelText("Attach")).toBeInTheDocument();
    });
  });

  it("should have accessible name on connectors button", async () => {
    await renderChatPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Connectors")).toBeInTheDocument();
    });
  });

  it("should disable Send button when input is empty", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeDisabled();
    });
  });

  it("should enable Send button when input has text", async () => {
    await renderChatPage();

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(
        "Ask me to automate workflows, manage tasks...",
      );
    });

    await fill(textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).not.toBeDisabled();
    });
  });
});

describe("zero chat page - file input ref", () => {
  it("should open file picker when Attach button is clicked", async () => {
    const user = userEvent.setup();
    await renderChatPage();

    const attachButton = await waitFor(() => {
      return screen.getByLabelText("Attach");
    });

    // The hidden file input should exist in the DOM
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeInTheDocument();
    if (!fileInput) {
      throw new Error("file input not found");
    }

    // Mock the click method to verify it gets called
    const clickSpy = vi.fn();
    fileInput.click = clickSpy;

    await user.click(attachButton);

    expect(clickSpy).toHaveBeenCalledOnce();
  });
});

describe("zero chat page - connectors popover", () => {
  it("should open add connectors dialog when clicking Add connectors in popover", async () => {
    const user = userEvent.setup();
    await renderChatPage();

    const connectorsButton = await waitFor(() => {
      return screen.getByLabelText("Connectors");
    });

    await user.click(connectorsButton);

    const addButton = await waitFor(() => {
      return screen.getByText("Add connectors");
    });

    await user.click(addButton);

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Search connectors..."),
      ).toBeInTheDocument();
    });
  });

  it("should show unconnected connectors in AddConnectorsDialog with connect buttons", async () => {
    const user = userEvent.setup();
    await renderChatPage();

    const connectorsButton = await waitFor(() => {
      return screen.getByLabelText("Connectors");
    });
    await user.click(connectorsButton);

    const addButton = await waitFor(() => {
      return screen.getByText("Add connectors");
    });
    await user.click(addButton);

    // Dialog should show available (unconnected) connectors with Connect buttons
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Search connectors..."),
      ).toBeInTheDocument();
    });

    // Default mock has no org connectors, so all types are unconnected.
    // Check that at least one "Connect X" button exists.
    const connectButtons = screen.getAllByRole("button").filter((el) => {
      return (el.getAttribute("aria-label") ?? "").startsWith("Connect ");
    });
    expect(connectButtons.length).toBeGreaterThan(0);
  });

  it("should filter connectors when searching in AddConnectorsDialog", async () => {
    const user = userEvent.setup();
    await renderChatPage();

    const connectorsButton = await waitFor(() => {
      return screen.getByLabelText("Connectors");
    });
    await user.click(connectorsButton);

    const addButton = await waitFor(() => {
      return screen.getByText("Add connectors");
    });
    await user.click(addButton);

    const searchInput = await waitFor(() => {
      return screen.getByPlaceholderText("Search connectors...");
    });

    // Before filtering: GitHub should be visible
    await waitFor(() => {
      expect(screen.getByLabelText("Connect GitHub")).toBeInTheDocument();
    });

    // Type a filter that won't match GitHub
    await fill(searchInput, "Slack");

    await waitFor(() => {
      expect(screen.queryByLabelText("Connect GitHub")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Connect Slack")).toBeInTheDocument();
    });
  });

  it("should sort connected connectors by added status in popover", async () => {
    // Set up: axiom and github are org-connected, only axiom is added to agent
    server.use(
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json({
          connectors: [
            {
              id: crypto.randomUUID(),
              type: "axiom",
              authMethod: "api-token",
              externalId: null,
              externalUsername: null,
              externalEmail: null,
              oauthScopes: null,
              needsReconnect: false,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
            {
              id: crypto.randomUUID(),
              type: "github",
              authMethod: "oauth",
              externalId: null,
              externalUsername: null,
              externalEmail: null,
              oauthScopes: ["repo"],
              needsReconnect: false,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
          configuredTypes: ["axiom", "github"],
          connectorProvidedSecretNames: [],
        });
      }),
      http.get(
        "*/api/zero/agents/c0000000-0000-4000-a000-000000000001/user-connectors",
        () => {
          return HttpResponse.json({ enabledTypes: ["axiom"] });
        },
      ),
    );
    mockChatAPI();
    await setupPage({ context, path: "/" });

    const user = userEvent.setup();
    const connectorsButton = await waitFor(() => {
      return screen.getByLabelText("Connectors");
    });
    await user.click(connectorsButton);

    // Both connectors should appear in the popover
    await waitFor(() => {
      expect(screen.getByText("Axiom")).toBeInTheDocument();
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    // The added one (Axiom) should have a "Remove" toggle, GitHub should have "Add"
    expect(
      screen.getByRole("switch", { name: "Remove Axiom" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Add GitHub" }),
    ).toBeInTheDocument();
  });
});

describe("zero chat page - connector label casing", () => {
  it("should display connector label from CONNECTOR_TYPES (e.g. 'Axiom') not the raw key ('axiom')", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/zero/agents/:name", ({ params }) => {
        if (
          params.name === "instructions" ||
          (typeof params.name === "string" && params.name.includes("/"))
        ) {
          return;
        }
        return HttpResponse.json({
          name: params.name,
          agentId: "c0000000-0000-4000-a000-000000000001",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          allowUnknownEndpoints: null,
        });
      }),
      http.get(
        "*/api/zero/agents/c0000000-0000-4000-a000-000000000001/user-connectors",
        () => {
          return HttpResponse.json({ enabledTypes: ["axiom"] });
        },
      ),
      // Axiom must be connected at org level for it to appear in the popover
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json({
          connectors: [
            {
              id: crypto.randomUUID(),
              authMethod: "api-token",
              externalId: null,
              externalUsername: null,
              externalEmail: null,
              oauthScopes: null,
              needsReconnect: false,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              type: "axiom",
            },
          ],
          configuredTypes: ["axiom"],
          connectorProvidedSecretNames: [],
        });
      }),
    );
    mockChatAPI();
    await setupPage({ context, path: "/" });

    const connectorsButton = await waitFor(() => {
      return screen.getByLabelText("Connectors");
    });

    await user.click(connectorsButton);

    await waitFor(() => {
      expect(screen.getByText("Axiom")).toBeInTheDocument();
    });
    expect(screen.queryByText("axiom")).not.toBeInTheDocument();
  });
});

describe("zero chat page - invite button", () => {
  it("renders invite button in DOM even when user is not admin", async () => {
    server.use(
      http.get("*/api/zero/org", () => {
        return HttpResponse.json({
          id: "org_1",
          slug: "user-12345678",
          name: "User 12345678",
          role: "member",
        });
      }),
    );

    await renderChatPage();

    // Wait for the page to fully load before checking the invite button
    await waitFor(() => {
      return screen.getByText(/Ideas & use cases/);
    });

    const button = screen.getByTestId("invite-button");
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-hidden", "true");
  });

  it("renders invite button as visible and accessible when user is admin", async () => {
    await renderChatPage();

    // Wait for the page to fully load before checking the invite button
    await waitFor(() => {
      return screen.getByText(/Ideas & use cases/);
    });

    // Button is always in DOM; wait for aria-hidden to be removed once admin state resolves
    await waitFor(() => {
      const button = screen.getByTestId("invite-button");
      expect(button).not.toHaveAttribute("aria-hidden", "true");
    });
  });
});

describe("zero chat page - agent avatar and greeting", () => {
  it("should render agent avatar link on the landing page", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByLabelText("View agent profile")).toBeInTheDocument();
    });
  });

  it("should link avatar to team detail page", async () => {
    await renderChatPage();

    const link = await waitFor(() => {
      return screen.getByLabelText("View agent profile");
    });
    expect(link).toHaveAttribute(
      "href",
      "/agents/c0000000-0000-4000-a000-000000000001",
    );
  });
});

describe("zero chat page - ideation page", () => {
  it("should navigate to ideation page when explore card is clicked", async () => {
    const user = userEvent.setup();
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByText("Ideas & use cases")).toBeInTheDocument();
    });

    // Find the "Ideas & use cases" text, then navigate up to the button and click it
    const exploreText = screen.getByText("Ideas & use cases");
    const exploreButton = exploreText.closest("button")!;
    expect(exploreButton).toBeInTheDocument();

    await user.click(exploreButton);

    await waitFor(() => {
      expect(
        screen.getByText(/Click any card to start a conversation/),
      ).toBeInTheDocument();
    });

    // Category tabs should be visible
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getAllByText("Reports").length).toBeGreaterThan(0);
    expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
  });

  async function navigateToIdeation(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => {
      expect(screen.getByText("Ideas & use cases")).toBeInTheDocument();
    });
    const exploreButton = screen
      .getByText("Ideas & use cases")
      .closest("button")!;
    await user.click(exploreButton);
    await waitFor(() => {
      expect(
        screen.getByText(/Click any card to start a conversation/),
      ).toBeInTheDocument();
    });
  }

  it("should filter categories when a tab is clicked", async () => {
    const user = userEvent.setup();
    await renderChatPage();
    await navigateToIdeation(user);

    // Click a specific category tab
    const githubCategoryBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "GitHub";
    });
    expect(githubCategoryBtn).toBeDefined();
    await user.click(githubCategoryBtn!);

    await waitFor(() => {
      // The selected category heading should be visible
      expect(
        screen.getByRole("heading", { name: "GitHub" }),
      ).toBeInTheDocument();
    });

    // Other category headings should not be visible
    expect(
      screen.queryByRole("heading", { name: "Reports" }),
    ).not.toBeInTheDocument();
  });

  it("should navigate back to chat and set prompt when a use case is clicked", async () => {
    const user = userEvent.setup();
    await renderChatPage();
    await navigateToIdeation(user);

    // Click a known use case card
    await user.click(screen.getByText("Daily standup report"));

    // Should navigate back to chat page with the prompt set
    await waitFor(() => {
      const textarea = screen.getByPlaceholderText(
        "Ask me to automate workflows, manage tasks...",
      );
      expect(textarea).toHaveValue(
        "Set up a daily standup report that pulls data from GitHub, Sentry, Axiom, and Plausible every morning, generates a pptx, and posts it to #all-vm0",
      );
    });
  });

  it("should navigate back to chat when breadcrumb is clicked", async () => {
    const user = userEvent.setup();
    await renderChatPage();
    await navigateToIdeation(user);

    // Click the Chat breadcrumb to go back
    const chatBreadcrumb = screen.getByText("Chat").closest("button")!;
    await user.click(chatBreadcrumb);

    // Should be back on the chat page
    await waitFor(() => {
      expect(screen.getByText("Ideas & use cases")).toBeInTheDocument();
    });
  });
});
