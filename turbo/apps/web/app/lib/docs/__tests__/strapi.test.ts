import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../src/mocks/server";
import { reloadEnv } from "../../../../src/env";
import { getDocsPageByPathFromStrapi, getDocsPagesFromStrapi } from "../strapi";

const STRAPI_URL = "https://test-strapi.example.com";

const mockDocsPages = [
  {
    id: 1,
    documentId: "doc-start",
    title: "Getting Started",
    description: "Start building with VM0.",
    slug: "getting-started",
    path: "getting-started",
    order: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    publishedAt: "2026-01-01T12:00:00.000Z",
    section: { title: "Guides", slug: "guides", order: 1 },
    body: "# Getting Started\n\nUse VM0 to run agents.",
  },
  {
    id: 2,
    documentId: "doc-cli",
    title: "CLI",
    description: "Install and use the CLI.",
    slug: "cli",
    path: "guides/cli",
    order: 2,
    createdAt: "2026-01-03T00:00:00.000Z",
    updatedAt: "2026-01-04T00:00:00.000Z",
    publishedAt: "2026-01-03T12:00:00.000Z",
    section: { title: "Guides", slug: "guides", order: 1 },
    blocks: [
      {
        __component: "shared.rich-text",
        id: 10,
        body: "Install the CLI and authenticate.",
      },
    ],
  },
];

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_STRAPI_URL", STRAPI_URL);
  reloadEnv();

  server.use(
    http.get(`${STRAPI_URL}/api/docs-pages`, ({ request }) => {
      const url = new URL(request.url);
      const pathFilter = url.searchParams.get("filters[$or][0][path][$eq]");
      const slugFilter = url.searchParams.get("filters[$or][1][slug][$eq]");

      if (pathFilter || slugFilter) {
        const page = mockDocsPages.find((item) => {
          return item.path === pathFilter || item.slug === slugFilter;
        });
        return HttpResponse.json({
          data: page ? [page] : [],
          meta: {},
        });
      }

      return HttpResponse.json({
        data: mockDocsPages,
        meta: {},
      });
    }),
  );
});

describe("docs/strapi", () => {
  it("fetches docs pages and transforms them", async () => {
    const pages = await getDocsPagesFromStrapi("en");

    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({
      path: "getting-started",
      slug: "getting-started",
      title: "Getting Started",
      description: "Start building with VM0.",
      content: "# Getting Started\n\nUse VM0 to run agents.",
      section: { title: "Guides", slug: "guides", order: 1 },
      order: 1,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(pages[0]?.readTime).toMatch(/\d+ min read/);
  });

  it("derives section metadata when section is a scalar string", async () => {
    server.use(
      http.get(`${STRAPI_URL}/api/docs-pages`, () => {
        return HttpResponse.json({
          data: [
            {
              id: 3,
              documentId: "doc-quickstart",
              title: "Quickstart",
              description: "Get started fast.",
              slug: "quickstart",
              path: "quickstart",
              order: 1,
              createdAt: "2026-05-01T00:00:00.000Z",
              updatedAt: "2026-05-01T00:00:00.000Z",
              publishedAt: "2026-05-01T00:00:00.000Z",
              section: "Getting Started",
              body: "# Quickstart",
            },
          ],
          meta: {},
        });
      }),
    );

    const pages = await getDocsPagesFromStrapi("en");

    expect(pages[0]?.section).toEqual({
      title: "Getting Started",
      slug: "getting-started",
      order: 0,
    });
  });

  it("fetches a single docs page by path", async () => {
    let capturedLocale: string | null = null;
    let capturedPath: string | null = null;

    server.use(
      http.get(`${STRAPI_URL}/api/docs-pages`, ({ request }) => {
        const url = new URL(request.url);
        capturedLocale = url.searchParams.get("locale");
        capturedPath = url.searchParams.get("filters[$or][0][path][$eq]");
        return HttpResponse.json({
          data: [mockDocsPages[1]],
          meta: {},
        });
      }),
    );

    const page = await getDocsPageByPathFromStrapi("guides/cli", "en");

    expect(capturedLocale).toBe("en");
    expect(capturedPath).toBe("guides/cli");
    expect(page).toMatchObject({
      path: "guides/cli",
      slug: "cli",
      content: "Install the CLI and authenticate.",
    });
  });

  it("returns null when a docs page is not found", async () => {
    const page = await getDocsPageByPathFromStrapi("missing", "en");

    expect(page).toBeNull();
  });

  it("returns an empty list when the docs collection is not available", async () => {
    server.use(
      http.get(`${STRAPI_URL}/api/docs-pages`, () => {
        return HttpResponse.json(
          {
            data: null,
            error: {
              status: 404,
              name: "NotFoundError",
              message: "Not Found",
              details: {},
            },
          },
          { status: 404, statusText: "Not Found" },
        );
      }),
    );

    await expect(getDocsPagesFromStrapi("en")).resolves.toEqual([]);
  });

  it("returns null when the docs collection is not available for a page", async () => {
    server.use(
      http.get(`${STRAPI_URL}/api/docs-pages`, () => {
        return HttpResponse.json(
          {
            data: null,
            error: {
              status: 404,
              name: "NotFoundError",
              message: "Not Found",
              details: {},
            },
          },
          { status: 404, statusText: "Not Found" },
        );
      }),
    );

    await expect(
      getDocsPageByPathFromStrapi("getting-started", "en"),
    ).resolves.toBeNull();
  });

  it("requests draft content when draft option is set", async () => {
    let capturedStatus: string | null = null;

    server.use(
      http.get(`${STRAPI_URL}/api/docs-pages`, ({ request }) => {
        const url = new URL(request.url);
        capturedStatus = url.searchParams.get("status");
        return HttpResponse.json({ data: [], meta: {} });
      }),
    );

    await getDocsPageByPathFromStrapi("getting-started", "en", {
      draft: true,
    });

    expect(capturedStatus).toBe("draft");
  });

  it("requests draft content for the page list when draft option is set", async () => {
    let capturedStatus: string | null = null;

    server.use(
      http.get(`${STRAPI_URL}/api/docs-pages`, ({ request }) => {
        const url = new URL(request.url);
        capturedStatus = url.searchParams.get("status");
        return HttpResponse.json({ data: [], meta: {} });
      }),
    );

    await getDocsPagesFromStrapi("en", { draft: true });

    expect(capturedStatus).toBe("draft");
  });

  it("throws when Strapi fetch fails", async () => {
    server.use(
      http.get(`${STRAPI_URL}/api/docs-pages`, () => {
        return new HttpResponse(null, {
          status: 500,
          statusText: "Internal Server Error",
        });
      }),
    );

    await expect(getDocsPagesFromStrapi("en")).rejects.toThrow(
      "Failed to fetch docs pages: 500 Internal Server Error",
    );
  });
});
