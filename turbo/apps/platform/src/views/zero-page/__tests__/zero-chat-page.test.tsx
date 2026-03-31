import type { ConnectorType } from "@vm0/core";
import { describe, expect, it, vi } from "vitest";
import {
  act,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { getCategories } from "../zero-ideation-data.ts";

/** Deterministic cards for tests (landing uses random prompts from ideation data). */
vi.mock("../zero-ideation-page.tsx", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../zero-ideation-page.tsx")>();
  return {
    ...mod,
    getRandomPrompts: (count: number) => {
      const prompts: {
        title: string;
        description: string;
        prompt: string;
        connectors: ConnectorType[];
      }[] = [
        {
          title: "Daily standup report",
          description:
            "Pull GitHub, Sentry, Axiom, and Plausible data every morning, generate a pptx, and post to a Slack channel",
          prompt:
            "Set up a daily standup report that pulls data from GitHub, Sentry, Axiom, and Plausible every morning, generates a pptx, and posts it to #all-vm0",
          connectors: ["github", "sentry", "axiom", "plausible", "slack"],
        },
        {
          title: "Morning brief",
          description:
            "Pull updates from Gmail, Calendar, and Notion to give you a clear plan for the day",
          prompt:
            "Set up a morning brief that pulls updates from Gmail, Calendar, and Notion every morning and posts a daily plan to Slack",
          connectors: ["gmail", "google-calendar", "notion", "slack"],
        },
        {
          title: "Batch-create issues",
          description:
            "Give Zero multiple issue instructions at once \u2014 it creates and assigns them automatically",
          prompt:
            "Create the following GitHub issues and assign them to the right people: 1) ... 2) ... 3) ...",
          connectors: ["github"],
        },
      ];
      return prompts.slice(0, count);
    },
  };
});

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
  const allUseCases = getCategories().flatMap((c) => c.cases);
  const allTitles = new Set(allUseCases.map((u) => u.title));
  const promptByTitle = new Map(allUseCases.map((u) => [u.title, u.prompt]));

  it("should render suggested prompt cards from the use case dataset", async () => {
    await renderChatPage();

    const exploreButton = await waitFor(() =>
      screen.getByRole("button", { name: /Ideas & use cases/ }),
    );
    expect(exploreButton).toBeInTheDocument();

    // The prompt grid is the parent of the "Ideas & use cases" button
    const promptGrid = exploreButton.parentElement!;
    const gridButtons = within(promptGrid).getAllByRole("button");

    // 2 random prompt cards + 1 "Ideas & use cases" card
    expect(gridButtons).toHaveLength(3);

    // Each random card title should come from the known dataset
    for (const button of gridButtons) {
      const text = button.textContent ?? "";
      if (text.includes("Ideas & use cases")) {
        continue;
      }
      const matchesDataset = allUseCases.some((u) => text.includes(u.title));
      expect(matchesDataset).toBeTruthy();
    }
  });

  it("should populate composer with the correct prompt when a card is clicked", async () => {
    await renderChatPage();

    const exploreButton = await waitFor(() =>
      screen.getByRole("button", { name: /Ideas & use cases/ }),
    );
    const promptGrid = exploreButton.parentElement!;
    const gridButtons = within(promptGrid).getAllByRole("button");

    // Find the first random prompt card (not "Ideas & use cases")
    const promptCard = gridButtons.find(
      (btn) => !btn.textContent?.includes("Ideas & use cases"),
    )!;

    // Identify which use case this card represents
    const cardTitle = [...allTitles].find((title) =>
      promptCard.textContent?.includes(title),
    )!;
    const expectedPrompt = promptByTitle.get(cardTitle)!;

    fireEvent.click(promptCard);

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
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    });
  });

  it("should render Attach button", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Attach" }),
      ).toBeInTheDocument();
    });
  });

  it("should have accessible name on connectors button", async () => {
    await renderChatPage();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connectors" }),
      ).toBeInTheDocument();
    });
  });

  it("should disable Send button when input is empty", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    });
  });

  it("should enable Send button when input has text", async () => {
    await renderChatPage();

    const textarea = await waitFor(() =>
      screen.getByPlaceholderText(
        "Ask me to automate workflows, manage tasks...",
      ),
    );

    fireEvent.change(textarea, { target: { value: "Hello" } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
    });
  });
});

describe("zero chat page - file input ref", () => {
  it("should open file picker when Attach button is clicked", async () => {
    await renderChatPage();

    const attachButton = await waitFor(() =>
      screen.getByRole("button", { name: "Attach" }),
    );

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

    fireEvent.click(attachButton);

    expect(clickSpy).toHaveBeenCalledOnce();
  });
});

describe("zero chat page - connectors popover", () => {
  it("should navigate to connectors page when clicking Manage connectors in popover", async () => {
    await renderChatPage();

    const connectorsButton = await waitFor(() =>
      screen.getByRole("button", { name: "Connectors" }),
    );

    fireEvent.click(connectorsButton);

    const manageButton = await waitFor(() =>
      screen.getByText("Manage connectors"),
    );

    fireEvent.click(manageButton);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Connect third-party services for your agents to use.",
        ),
      ).toBeInTheDocument();
    });
  });
});

describe("zero chat page - connector label casing", () => {
  it("should display connector label from CONNECTOR_TYPES (e.g. 'Axiom') not the raw key ('axiom')", async () => {
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
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          firewallPolicies: null,
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

    const connectorsButton = await waitFor(() =>
      screen.getByRole("button", { name: "Connectors" }),
    );

    fireEvent.click(connectorsButton);

    await waitFor(() => {
      expect(screen.getByText("Axiom")).toBeInTheDocument();
    });
    expect(screen.queryByText("axiom")).not.toBeInTheDocument();
  });
});

describe("zero chat page - agent avatar and greeting", () => {
  it("should render agent avatar link on the landing page", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(
        screen.getByRole("link", { name: "View agent profile" }),
      ).toBeInTheDocument();
    });
  });

  it("should link avatar to team detail page", async () => {
    await renderChatPage();

    const link = await waitFor(() =>
      screen.getByRole("link", { name: "View agent profile" }),
    );
    expect(link).toHaveAttribute(
      "href",
      "/team/c0000000-0000-4000-a000-000000000001",
    );
  });
});

describe("zero chat page - ideation page", () => {
  it("should navigate to ideation page when explore card is clicked", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByText("Ideas & use cases")).toBeInTheDocument();
    });

    // Find the "Ideas & use cases" text, then navigate up to the button and click it
    const exploreText = screen.getByText("Ideas & use cases");
    const exploreButton = exploreText.closest("button")!;
    expect(exploreButton).toBeInTheDocument();

    await act(() => {
      fireEvent.click(exploreButton);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Click any card to start a conversation/),
      ).toBeInTheDocument();
    });

    // Category tabs should be visible
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reports" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "GitHub" })).toBeInTheDocument();
  });

  async function navigateToIdeation() {
    await waitFor(() => {
      expect(screen.getByText("Ideas & use cases")).toBeInTheDocument();
    });
    const exploreButton = screen
      .getByText("Ideas & use cases")
      .closest("button")!;
    await act(() => {
      fireEvent.click(exploreButton);
    });
    await waitFor(() => {
      expect(
        screen.getByText(/Click any card to start a conversation/),
      ).toBeInTheDocument();
    });
  }

  it("should filter categories when a tab is clicked", async () => {
    await renderChatPage();
    await navigateToIdeation();

    // Click a specific category tab
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));

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
    await renderChatPage();
    await navigateToIdeation();

    // Click a known use case card
    await act(() => {
      fireEvent.click(screen.getByText("Daily standup report"));
    });

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
    await renderChatPage();
    await navigateToIdeation();

    // Click the Chat breadcrumb to go back
    const chatBreadcrumb = screen.getByText("Chat").closest("button")!;
    await act(() => {
      fireEvent.click(chatBreadcrumb);
    });

    // Should be back on the chat page
    await waitFor(() => {
      expect(screen.getByText("Ideas & use cases")).toBeInTheDocument();
    });
  });
});
