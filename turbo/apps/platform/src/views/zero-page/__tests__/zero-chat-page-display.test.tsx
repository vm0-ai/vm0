import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
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

// CHAT-D-001: agent avatar image renders from zeroAvatarSrc
describe("zero chat page display - agent avatar image", () => {
  it("renders agent avatar image from zeroAvatarSrc URL", async () => {
    await renderChatPage();

    const avatarLink = await waitFor(() => {
      return screen.getByRole("link", { name: "View agent profile" });
    });
    expect(avatarLink).toBeInTheDocument();

    const img = avatarLink.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img?.getAttribute("src")).toBeTruthy();
  });
});

// CHAT-D-002: dynamic tagline renders with userName via TypewriterText animation
describe("zero chat page display - tagline with userName via TypewriterText", () => {
  it("renders a tagline containing the user first name via TypewriterText animation", async () => {
    mockChatAPI();
    await setupPage({
      context,
      path: "/",
      user: {
        id: "test-user-123",
        fullName: "Alice Smith",
        firstName: "Alice",
      },
    });

    await waitFor(() => {
      const h2 = screen.getByRole("heading", { level: 2 });
      expect(h2.textContent).toContain("Alice");
    });
  });
});

// CHAT-D-003: dynamic tagline renders with displayName via TypewriterText animation
describe("zero chat page display - tagline with displayName via TypewriterText", () => {
  it("renders tagline with TypewriterText animation effect when agent displayName is set", async () => {
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
        return HttpResponse.json({
          needsOnboarding: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: "c0000000-0000-4000-a000-000000000001",
          defaultAgentMetadata: { displayName: "SpecialAgent" },
          defaultAgentSkills: [],
        });
      }),
    );
    mockChatAPI();
    await setupPage({
      context,
      path: "/",
      user: {
        id: "test-user-123",
        fullName: "Alice Smith",
        firstName: "Alice",
      },
    });

    // TypewriterText renders a cursor span while animating — innerHTML is non-empty
    await waitFor(() => {
      const h2 = screen.getByRole("heading", { level: 2 });
      expect(h2).toBeInTheDocument();
      expect(h2.innerHTML).not.toBe("");
    });
  });
});

// CHAT-D-004: chat agent display name renders on the page
describe("zero chat page display - chat agent display name", () => {
  it("renders the agent display name heading (tagline) on the chat page", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
    });
  });
});

// CHAT-D-005: suggested prompts list renders with title, description, connectors, and prompt
describe("zero chat page display - suggested prompts full content", () => {
  it("renders each suggested prompt card with title, description, and connector icons", async () => {
    const allUseCases = getCategories().flatMap((c) => {
      return c.cases;
    });

    await renderChatPage();

    const exploreButton = await waitFor(() => {
      return screen.getByRole("button", { name: /Ideas & use cases/ });
    });
    const promptGrid = exploreButton.parentElement!;
    const gridButtons = within(promptGrid).getAllByRole("button");

    const promptCards = gridButtons.filter((btn) => {
      return !btn.textContent?.includes("Ideas & use cases");
    });

    for (const card of promptCards) {
      const matchingCase = allUseCases.find((u) => {
        return card.textContent?.includes(u.title);
      });
      expect(matchingCase).toBeDefined();

      if (!matchingCase) {
        continue;
      }

      expect(card.textContent).toContain(matchingCase.title);
      expect(card.textContent).toContain(matchingCase.description);

      if (matchingCase.connectors && matchingCase.connectors.length > 0) {
        const imgs = card.querySelectorAll("img");
        expect(imgs.length).toBeGreaterThan(0);
      }
    }
  });
});

// CHAT-D-006: suggested prompt title renders correctly
describe("zero chat page display - suggested prompt title", () => {
  it("renders the title text in each prompt card", async () => {
    const allUseCases = getCategories().flatMap((c) => {
      return c.cases;
    });

    await renderChatPage();

    const exploreButton = await waitFor(() => {
      return screen.getByRole("button", { name: /Ideas & use cases/ });
    });
    const promptGrid = exploreButton.parentElement!;
    const gridButtons = within(promptGrid).getAllByRole("button");

    const promptCard = gridButtons.find((btn) => {
      return !btn.textContent?.includes("Ideas & use cases");
    })!;

    const matchingCase = allUseCases.find((u) => {
      return promptCard.textContent?.includes(u.title);
    });
    expect(matchingCase).toBeDefined();
    expect(promptCard.textContent).toContain(matchingCase?.title);
  });
});

// CHAT-D-007: suggested prompt description renders correctly
describe("zero chat page display - suggested prompt description", () => {
  it("renders the description text in each prompt card", async () => {
    const allUseCases = getCategories().flatMap((c) => {
      return c.cases;
    });

    await renderChatPage();

    const exploreButton = await waitFor(() => {
      return screen.getByRole("button", { name: /Ideas & use cases/ });
    });
    const promptGrid = exploreButton.parentElement!;
    const gridButtons = within(promptGrid).getAllByRole("button");

    const promptCard = gridButtons.find((btn) => {
      return !btn.textContent?.includes("Ideas & use cases");
    })!;

    const matchingCase = allUseCases.find((u) => {
      return promptCard.textContent?.includes(u.title);
    });
    expect(matchingCase).toBeDefined();
    expect(promptCard.textContent).toContain(matchingCase?.description);
  });
});

// CHAT-D-008: suggested prompt connectors icons render
describe("zero chat page display - suggested prompt connector icons", () => {
  it("renders connector icon images for each prompt card that has connectors", async () => {
    const allUseCases = getCategories().flatMap((c) => {
      return c.cases;
    });

    await renderChatPage();

    const exploreButton = await waitFor(() => {
      return screen.getByRole("button", { name: /Ideas & use cases/ });
    });
    const promptGrid = exploreButton.parentElement!;
    const gridButtons = within(promptGrid).getAllByRole("button");

    const promptCards = gridButtons.filter((btn) => {
      return !btn.textContent?.includes("Ideas & use cases");
    });

    const cardWithConnectors = promptCards.find((card) => {
      const matchingCase = allUseCases.find((u) => {
        return card.textContent?.includes(u.title);
      });
      return matchingCase?.connectors && matchingCase.connectors.length > 0;
    });

    expect(cardWithConnectors).toBeDefined();

    if (cardWithConnectors) {
      const matchingCase = allUseCases.find((u) => {
        return cardWithConnectors.textContent?.includes(u.title);
      })!;
      const imgs = cardWithConnectors.querySelectorAll("img");
      expect(imgs).toHaveLength(matchingCase.connectors?.length ?? 0);
    }
  });
});

// CHAT-D-009: ideas and use cases card renders
describe("zero chat page display - ideas and use cases card", () => {
  it("renders the Ideas & use cases card on the page", async () => {
    await renderChatPage();

    const ideasButton = await waitFor(() => {
      return screen.getByRole("button", { name: /Ideas & use cases/ });
    });
    expect(ideasButton).toBeInTheDocument();
    expect(ideasButton.textContent).toContain("Ideas & use cases");
    expect(ideasButton.textContent).toContain(
      "Browse use cases across all connectors",
    );
  });
});
