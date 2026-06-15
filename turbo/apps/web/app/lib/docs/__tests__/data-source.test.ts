import { describe, expect, it } from "vitest";
import { buildDocsNavigation } from "../data-source";
import type { DocsPage } from "../types";

function makePage(overrides: Partial<DocsPage>): DocsPage {
  return {
    path: "getting-started",
    slug: "getting-started",
    title: "Getting Started",
    description: "Start here.",
    content: "Body",
    section: { title: "Guides", slug: "guides", order: 1 },
    order: 1,
    publishedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    readTime: "1 min read",
    ...overrides,
  };
}

describe("docs/data-source", () => {
  it("groups and sorts docs navigation by section and page order", () => {
    const navigation = buildDocsNavigation([
      makePage({
        path: "reference/api",
        title: "API",
        section: { title: "Reference", slug: "reference", order: 2 },
        order: 1,
      }),
      makePage({
        path: "guides/cli",
        title: "CLI",
        section: { title: "Guides", slug: "guides", order: 1 },
        order: 2,
      }),
      makePage({
        path: "getting-started",
        title: "Getting Started",
        section: { title: "Guides", slug: "guides", order: 1 },
        order: 1,
      }),
    ]);

    expect(
      navigation.map((section) => {
        return section.slug;
      }),
    ).toEqual(["guides", "reference"]);
    expect(
      navigation[0]?.pages.map((page) => {
        return page.path;
      }),
    ).toEqual(["getting-started", "guides/cli"]);
  });
});
