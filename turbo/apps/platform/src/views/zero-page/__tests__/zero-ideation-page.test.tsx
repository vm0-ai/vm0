import { describe, expect, it } from "vitest";
import { act, screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { getCategories } from "../zero-ideation-data.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

function mockChatAPI() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function renderIdeationPage() {
  mockChatAPI();
  await setupPage({ context, path: "/ideas" });
}

describe("ideation page - direct route rendering", () => {
  it("should render the ideation page when navigating to /ideas", async () => {
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
    const breadcrumbNav = screen.getByRole("navigation");
    expect(breadcrumbNav).toHaveTextContent("Ideas & Use Cases");
  });
});

describe("ideation page - category tabs", () => {
  const categories = getCategories().slice(0, 5);

  it("should render All tab and each category tab", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    });

    for (const category of categories) {
      expect(
        screen.getByRole("button", { name: category.title }),
      ).toBeInTheDocument();
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

  it("should filter to a single category when its tab is clicked", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "GitHub" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));

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
        screen.getByRole("button", { name: "GitHub" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Reports" }),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "All" }));

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

    const searchInput = await waitFor(() =>
      screen.getByRole("searchbox", { name: "Search use cases" }),
    );

    fireEvent.change(searchInput, { target: { value: "Daily standup" } });

    await waitFor(() => {
      expect(screen.getByText("Daily standup report")).toBeInTheDocument();
    });

    // Unrelated use cases should not be visible
    expect(screen.queryByText("Batch-create issues")).not.toBeInTheDocument();
  });

  it("should show empty message when no use cases match", async () => {
    await renderIdeationPage();

    const searchInput = await waitFor(() =>
      screen.getByRole("searchbox", { name: "Search use cases" }),
    );

    fireEvent.change(searchInput, {
      target: { value: "xyznonexistentquery" },
    });

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
});

describe("ideation page - navigation", () => {
  it("should navigate to / when a use case card is clicked", async () => {
    await renderIdeationPage();

    await waitFor(() => {
      expect(screen.getByText("Daily standup report")).toBeInTheDocument();
    });

    await act(() => {
      fireEvent.click(screen.getByText("Daily standup report"));
    });

    await waitFor(() => {
      expect(pathname()).not.toBe("/ideas");
    });
  });

  it("should navigate to / when Chat breadcrumb is clicked", async () => {
    await renderIdeationPage();

    const chatBreadcrumb = await waitFor(
      () => screen.getByText("Chat").closest("button")!,
    );

    await act(() => {
      fireEvent.click(chatBreadcrumb!);
    });

    await waitFor(() => {
      expect(pathname()).not.toBe("/ideas");
    });
  });
});
