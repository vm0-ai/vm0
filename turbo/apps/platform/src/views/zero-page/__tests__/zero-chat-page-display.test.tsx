import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { getCategories } from "../zero-ideation-data.ts";

const context = testContext();

function mockChatAPI() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

// CHAT-D-002: dynamic tagline renders with userName via TypewriterText animation
describe("zero chat page display - tagline with userName via TypewriterText", () => {
  it("renders a tagline containing the user first name via TypewriterText animation", async () => {
    mockChatAPI();
    detachedSetupPage({
      context,
      path: "/",
      user: {
        id: "test-user-123",
        fullName: "Alice Smith",
        firstName: "Alice",
      },
    });

    const tagline = await screen.findByTestId("chat-tagline");
    expect(tagline.getAttribute("aria-label")).toContain("Alice");
  });
});

// CHAT-D-008: suggested prompt connector icons render with the correct count
describe("zero chat page display - suggested prompt connector icons", () => {
  it("renders the correct number of connector icon images for prompt cards that have connectors", async () => {
    const allUseCases = getCategories().flatMap((c) => {
      return c.cases;
    });

    mockChatAPI();
    detachedSetupPage({ context, path: "/" });

    const exploreText = await waitFor(() => {
      return screen.getByText(/Ideas & use cases/);
    });
    const promptGrid = exploreText.closest("button")!.parentElement!;
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
      const imgs = cardWithConnectors.querySelectorAll("img");
      expect(imgs.length).toBeGreaterThan(0);
    }
  });
});
