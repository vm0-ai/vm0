import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { getCategories } from "../zero-ideation-data.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { pathname } from "../../../signals/location.ts";
import {
  setMockComposesList,
  setMockTeam,
} from "../../../mocks/handlers/api-agents.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const IDEAS_PATH = `/agents/${AGENT_ID}/ideas`;

function mockChatAPI() {
  server.use();
}

function renderIdeationPage() {
  mockChatAPI();
  detachedSetupPage({ context, path: IDEAS_PATH });
}

describe("ideation page - direct route rendering", () => {
  it("should render the ideation page when navigating to /talk/:id/ideas", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Ideas & Use Cases" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Click any card to start a conversation/),
    ).toBeInTheDocument();
  });

  it("should set document title", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(document.title).toBe("Ideas & Use Cases | VM0");
    });
  });

  it("should render breadcrumb with Chat link", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(screen.getByText("Chat").closest("button")).toBeInTheDocument();
    });

    // Breadcrumb text (non-heading) should also be present
    const chatButton = screen.getByText("Chat").closest("button")!;
    const breadcrumbNav = chatButton.closest("nav")!;
    expect(breadcrumbNav).toHaveTextContent("Ideas & Use Cases");
  });
});

describe("ideation page - category tabs", () => {
  const categories = getCategories(undefined).slice(0, 5);

  it("should render All tab and each category tab", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(screen.getByText("All")).toBeInTheDocument();
    });

    for (const category of categories) {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === category.title;
        }),
      ).toBeDefined();
    }
  });

  it("should show all category headings when All tab is active", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: categories[0].title }),
      ).toBeInTheDocument();
    });

    for (const category of categories) {
      expect(
        screen.getByRole("heading", { name: category.title }),
      ).toBeInTheDocument();
    }
  });

  it("should highlight the selected category tab as active", async () => {
    await renderIdeationPage();

    const allTab = await waitFor(() => {
      return screen.getByText("All");
    });
    const githubTab = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "GitHub";
    });
    expect(githubTab).toBeDefined();

    // Initially "All" tab should have active styling
    expect(allTab.className).toContain("bg-muted text-foreground");
    expect(githubTab!.className).not.toContain("bg-muted text-foreground");

    // Click GitHub tab
    click(githubTab!);

    // GitHub tab should now have active styling, All should not
    await waitFor(() => {
      expect(githubTab!.className).toContain("bg-muted text-foreground");
    });
    expect(allTab.className).not.toContain("bg-muted text-foreground");
  });

  it("should filter to a single category when its tab is clicked", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "GitHub";
        }),
      ).toBeDefined();
    });

    click(
      screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "GitHub";
      })!,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "GitHub" }),
      ).toBeInTheDocument();
    });

    // Other categories should not be visible
    expect(
      screen.queryByRole("heading", { name: "Reports" }),
    ).not.toBeInTheDocument();
  });

  it("should show all categories again when All tab is clicked after filtering", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "GitHub";
        }),
      ).toBeDefined();
    });

    click(
      screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "GitHub";
      })!,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Reports" }),
      ).not.toBeInTheDocument();
    });

    click(screen.getByText("All"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Reports" }),
      ).toBeInTheDocument();
    });
  });
});

describe("ideation page - search", () => {
  it("should render search input", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(
        screen.getByRole("searchbox", { name: "Search use cases" }),
      ).toBeInTheDocument();
    });
  });

  it("should filter use cases by title", async () => {
    await renderIdeationPage();

    const searchInput = await waitFor(() => {
      return screen.getByRole("searchbox", { name: "Search use cases" });
    });

    await fill(searchInput, "Daily standup");

    await waitFor(() => {
      expect(screen.getByText("Daily standup report")).toBeInTheDocument();
    });

    // Unrelated use cases should not be visible
    expect(screen.queryByText("Batch-create issues")).not.toBeInTheDocument();
  });

  it("should show empty message when no use cases match", async () => {
    await renderIdeationPage();

    const searchInput = await waitFor(() => {
      return screen.getByRole("searchbox", { name: "Search use cases" });
    });

    await fill(searchInput, "xyznonexistentquery");

    await waitFor(() => {
      expect(
        screen.getByText("No use cases match your search."),
      ).toBeInTheDocument();
    });
  });
});

describe("ideation page - use case cards", () => {
  it("should render use case cards with title and description", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(screen.getByText("Daily standup report")).toBeInTheDocument();
    });

    expect(
      screen.getByText("Morning metrics become a slide deck posted to Slack"),
    ).toBeInTheDocument();
  });

  it("should render connector icons for use cases that have connectors", async () => {
    await renderIdeationPage();

    // "Daily standup report" has 5 connectors: github, sentry, axiom, plausible, slack
    const cardTitle = await waitFor(() => {
      return screen.getByText("Daily standup report");
    });

    const card = cardTitle.closest(".zero-card")!;
    const connectorImages = card.querySelectorAll("img");
    expect(connectorImages).toHaveLength(5);
  });
});

describe("ideation page - sidebar layout", () => {
  it("should render within sidebar layout", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Ideas & Use Cases" }),
      ).toBeInTheDocument();
    });

    // SidebarLayout renders .zero-app wrapper
    expect(document.querySelector(".zero-app")).toBeInTheDocument();
  });
});

describe("ideation page - navigation", () => {
  it("should navigate to /talk/:id when a use case card is clicked", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(screen.getByText("Daily standup report")).toBeInTheDocument();
    });

    click(screen.getByText("Daily standup report"));

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    });
  });

  it("should navigate to /talk/:id when Chat breadcrumb is clicked", async () => {
    await renderIdeationPage();

    const chatBreadcrumb = await waitFor(() => {
      return screen.getByText("Chat").closest("button")!;
    });

    click(chatBreadcrumb!);

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    });
  });

  it("should preserve agent ID from URL across navigation", async () => {
    const customAgentId = "custom-agent-42";
    mockChatAPI();
    setMockComposesList([
      {
        id: customAgentId,
        name: "custom-agent",
        displayName: "Custom Agent",
        description: null,
        sound: null,
        headVersionId: "v1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    setMockTeam([
      {
        id: customAgentId,
        displayName: "Custom Agent",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "v1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    detachedSetupPage({ context, path: `/agents/${customAgentId}/ideas` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Ideas & Use Cases" }),
      ).toBeInTheDocument();
    });

    // Navigate back via breadcrumb — should go to the same agent's chat
    const chatBreadcrumb = screen.getByText("Chat").closest("button")!;
    click(chatBreadcrumb);

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${customAgentId}/chat`);
    });
  });
});

describe("ideation page - ZapierConnector feature switch", () => {
  it("should hide the Zapier use case card when ZapierConnector switch is off (default)", async () => {
    mockChatAPI();
    detachedSetupPage({ context, path: IDEAS_PATH });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Ideas & Use Cases" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByText("Zapier → VM0 migration"),
    ).not.toBeInTheDocument();
  });

  it("should show the Zapier use case card when ZapierConnector switch is on", async () => {
    mockChatAPI();
    detachedSetupPage({
      context,
      path: IDEAS_PATH,
      featureSwitches: { [FeatureSwitchKey.ZapierConnector]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Zapier → VM0 migration")).toBeInTheDocument();
    });
  });
});

describe("ideation page - LarkConnector feature switch", () => {
  it("should hide the Lark use case card when LarkConnector switch is off (default)", async () => {
    mockChatAPI();
    detachedSetupPage({ context, path: IDEAS_PATH });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Ideas & Use Cases" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByText("Lark \u2194 Slack message relay"),
    ).not.toBeInTheDocument();
  });

  it("should show the Lark use case card when LarkConnector switch is on", async () => {
    mockChatAPI();
    detachedSetupPage({
      context,
      path: IDEAS_PATH,
      featureSwitches: { [FeatureSwitchKey.LarkConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Lark \u2194 Slack message relay"),
      ).toBeInTheDocument();
    });
  });
});
