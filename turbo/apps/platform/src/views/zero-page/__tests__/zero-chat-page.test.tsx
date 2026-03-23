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
      screen.getByRole("button", { name: /Explore more ideas/ }),
    );
    expect(exploreButton).toBeInTheDocument();

    // The prompt grid is the parent of the "Explore more ideas" button
    const promptGrid = exploreButton.parentElement!;
    const gridButtons = within(promptGrid).getAllByRole("button");

    // 3 random prompt cards + 1 "Explore more ideas" card
    expect(gridButtons).toHaveLength(4);

    // Each random card title should come from the known dataset
    for (const button of gridButtons) {
      const text = button.textContent ?? "";
      if (text.includes("Explore more ideas")) {
        continue;
      }
      const matchesDataset = allUseCases.some((u) => text.includes(u.title));
      expect(matchesDataset).toBeTruthy();
    }
  });

  it("should populate composer with the correct prompt when a card is clicked", async () => {
    await renderChatPage();

    const exploreButton = await waitFor(() =>
      screen.getByRole("button", { name: /Explore more ideas/ }),
    );
    const promptGrid = exploreButton.parentElement!;
    const gridButtons = within(promptGrid).getAllByRole("button");

    // Find the first random prompt card (not "Explore more ideas")
    const promptCard = gridButtons.find(
      (btn) => !btn.textContent?.includes("Explore more ideas"),
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

describe("zero chat page - add connector dialog", () => {
  it("should open add connector dialog when clicking Add connector in popover", async () => {
    await renderChatPage();

    const connectorsButton = await waitFor(() =>
      screen.getByRole("button", { name: "Connectors" }),
    );

    fireEvent.click(connectorsButton);

    const addConnectorButton = await waitFor(() =>
      screen.getByText("Add connector"),
    );

    fireEvent.click(addConnectorButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});

describe("zero chat page - agent avatar and greeting", () => {
  it("should render agent avatar on the landing page", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "View agent profile" }),
      ).toBeInTheDocument();
    });
  });
});

describe("zero chat page - ideation page", () => {
  it("should navigate to ideation page when explore card is clicked", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByText("Explore more ideas")).toBeInTheDocument();
    });

    // Find the "Explore more ideas" text, then navigate up to the button and click it
    const exploreText = screen.getByText("Explore more ideas");
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
    expect(
      screen.getByRole("button", { name: "Automated Reports" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "GitHub Operations" }),
    ).toBeInTheDocument();
  });

  async function navigateToIdeation() {
    await waitFor(() => {
      expect(screen.getByText("Explore more ideas")).toBeInTheDocument();
    });
    const exploreButton = screen
      .getByText("Explore more ideas")
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
    fireEvent.click(screen.getByRole("button", { name: "GitHub Operations" }));

    await waitFor(() => {
      // The selected category heading should be visible
      expect(
        screen.getByRole("heading", { name: "GitHub Operations" }),
      ).toBeInTheDocument();
    });

    // Other category headings should not be visible
    expect(
      screen.queryByRole("heading", { name: "Automated Reports" }),
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
      expect(screen.getByText("Explore more ideas")).toBeInTheDocument();
    });
  });
});
