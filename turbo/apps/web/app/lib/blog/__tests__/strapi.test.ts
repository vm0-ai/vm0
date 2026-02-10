import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../src/mocks/server";

const STRAPI_URL = "https://test-strapi.example.com";

// Mock articles for testing
const mockArticles = [
  {
    id: 1,
    documentId: "doc-1",
    title: "Test Post",
    description: "Test description",
    slug: "test-post",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    publishedAt: "2024-01-01T12:00:00.000Z",
    cover: { url: "https://cdn.example.com/image.jpg" },
    author: { name: "John Doe" },
    category: { name: "Technology", slug: "technology" },
    blocks: [
      {
        __component: "shared.rich-text",
        id: 1,
        body: "This is the content of the post with many words to test read time calculation.",
      },
    ],
  },
];

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_STRAPI_URL", STRAPI_URL);

  // Register base handlers for Strapi API
  server.use(
    // Mock GET /api/articles
    http.get(`${STRAPI_URL}/api/articles`, ({ request }) => {
      const url = new URL(request.url);
      const slug = url.searchParams.get("filters[slug][$eq]");
      const limit = url.searchParams.get("pagination[limit]");

      // If filtering by slug
      if (slug) {
        const article = mockArticles.find((a) => a.slug === slug);
        return HttpResponse.json({
          data: article ? [article] : [],
          meta: {},
        });
      }

      // If requesting featured (limit=1)
      if (limit === "1") {
        return HttpResponse.json({
          data: mockArticles.slice(0, 1),
          meta: {},
        });
      }

      // Default: return all articles
      return HttpResponse.json({
        data: mockArticles,
        meta: {},
      });
    }),

    // Mock GET /api/categories
    http.get(`${STRAPI_URL}/api/categories`, () => {
      return HttpResponse.json({
        data: [
          { id: 1, name: "Technology", slug: "technology" },
          { id: 2, name: "Business", slug: "business" },
          { id: 3, name: "Lifestyle", slug: "lifestyle" },
        ],
        meta: {},
      });
    }),
  );
});

describe("blog/strapi", () => {
  describe("getPostsFromStrapi", () => {
    it("fetches posts and transforms them correctly", async () => {
      const { getPostsFromStrapi } = await import("../strapi");
      const posts = await getPostsFromStrapi("en");

      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        slug: "test-post",
        title: "Test Post",
        excerpt: "Test description",
        category: "Technology",
        author: { name: "John Doe" },
        cover: "https://cdn.example.com/image.jpg",
        featured: false,
      });
      expect(posts[0]?.readTime).toMatch(/\d+ min read/);
    });

    it("throws error when fetch fails", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/articles`, () => {
          return new HttpResponse(null, {
            status: 500,
            statusText: "Internal Server Error",
          });
        }),
      );

      const { getPostsFromStrapi } = await import("../strapi");

      await expect(getPostsFromStrapi("en")).rejects.toThrow(
        "Failed to fetch posts: 500 Internal Server Error",
      );
    });

    it("uses default locale when not provided", async () => {
      let capturedLocale: string | null = null;

      server.use(
        http.get(`${STRAPI_URL}/api/articles`, ({ request }) => {
          const url = new URL(request.url);
          capturedLocale = url.searchParams.get("locale");
          return HttpResponse.json({ data: [], meta: {} });
        }),
      );

      const { getPostsFromStrapi } = await import("../strapi");
      await getPostsFromStrapi();

      expect(capturedLocale).toBe("en");
    });

    it("handles articles without optional fields", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/articles`, () => {
          return HttpResponse.json({
            data: [
              {
                id: 1,
                documentId: "doc-1",
                title: "Minimal Post",
                description: "",
                slug: "minimal-post",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                publishedAt: "",
              },
            ],
            meta: {},
          });
        }),
      );

      const { getPostsFromStrapi } = await import("../strapi");
      const posts = await getPostsFromStrapi("en");

      expect(posts[0]).toMatchObject({
        slug: "minimal-post",
        category: "General",
        author: { name: "VM0 Team" },
        cover: "/covers/default.png",
      });
    });
  });

  describe("getPostBySlugFromStrapi", () => {
    it("fetches single post by slug", async () => {
      const { getPostBySlugFromStrapi } = await import("../strapi");
      const post = await getPostBySlugFromStrapi("test-post", "en");

      expect(post).not.toBeNull();
      expect(post?.slug).toBe("test-post");
    });

    it("returns null when post not found", async () => {
      const { getPostBySlugFromStrapi } = await import("../strapi");
      const post = await getPostBySlugFromStrapi("non-existent", "en");

      expect(post).toBeNull();
    });

    it("throws error when fetch fails", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/articles`, () => {
          return new HttpResponse(null, {
            status: 404,
            statusText: "Not Found",
          });
        }),
      );

      const { getPostBySlugFromStrapi } = await import("../strapi");

      await expect(getPostBySlugFromStrapi("test", "en")).rejects.toThrow(
        "Failed to fetch post by slug: 404 Not Found",
      );
    });
  });

  describe("getFeaturedPostFromStrapi", () => {
    it("fetches featured post and marks it as featured", async () => {
      const { getFeaturedPostFromStrapi } = await import("../strapi");
      const post = await getFeaturedPostFromStrapi("en");

      expect(post).not.toBeNull();
      expect(post?.featured).toBe(true);
    });

    it("returns null when no posts exist", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/articles`, () => {
          return HttpResponse.json({ data: [], meta: {} });
        }),
      );

      const { getFeaturedPostFromStrapi } = await import("../strapi");
      const post = await getFeaturedPostFromStrapi("en");

      expect(post).toBeNull();
    });

    it("throws error when fetch fails", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/articles`, () => {
          return new HttpResponse(null, {
            status: 503,
            statusText: "Service Unavailable",
          });
        }),
      );

      const { getFeaturedPostFromStrapi } = await import("../strapi");

      await expect(getFeaturedPostFromStrapi("en")).rejects.toThrow(
        "Failed to fetch featured post: 503 Service Unavailable",
      );
    });
  });

  describe("getAllCategoriesFromStrapi", () => {
    it("fetches and returns category names", async () => {
      const { getAllCategoriesFromStrapi } = await import("../strapi");
      const categories = await getAllCategoriesFromStrapi("en");

      expect(categories).toEqual(["Technology", "Business", "Lifestyle"]);
    });

    it("returns empty array when no categories exist", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/categories`, () => {
          return HttpResponse.json({ data: [], meta: {} });
        }),
      );

      const { getAllCategoriesFromStrapi } = await import("../strapi");
      const categories = await getAllCategoriesFromStrapi("en");

      expect(categories).toEqual([]);
    });

    it("throws error when fetch fails", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/categories`, () => {
          return new HttpResponse(null, {
            status: 500,
            statusText: "Internal Server Error",
          });
        }),
      );

      const { getAllCategoriesFromStrapi } = await import("../strapi");

      await expect(getAllCategoriesFromStrapi("en")).rejects.toThrow(
        "Failed to fetch categories: 500 Internal Server Error",
      );
    });
  });

  describe("article transformation", () => {
    it("handles relative cover URLs by prepending STRAPI_URL", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/articles`, () => {
          return HttpResponse.json({
            data: [
              {
                id: 1,
                documentId: "doc-1",
                title: "Test",
                description: "Test",
                slug: "test",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                publishedAt: "2024-01-01T00:00:00.000Z",
                cover: { url: "/uploads/image.jpg" },
              },
            ],
            meta: {},
          });
        }),
      );

      const { getPostsFromStrapi } = await import("../strapi");
      const posts = await getPostsFromStrapi("en");

      expect(posts[0]?.cover).toBe(`${STRAPI_URL}/uploads/image.jpg`);
    });

    it("transforms shared.quote blocks correctly", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/articles`, () => {
          return HttpResponse.json({
            data: [
              {
                id: 1,
                documentId: "doc-1",
                title: "Test",
                description: "Test",
                slug: "test",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                publishedAt: "2024-01-01T00:00:00.000Z",
                blocks: [
                  {
                    __component: "shared.quote",
                    id: 1,
                    title: "Famous Person",
                    body: "This is a quote",
                  },
                ],
              },
            ],
            meta: {},
          });
        }),
      );

      const { getPostsFromStrapi } = await import("../strapi");
      const posts = await getPostsFromStrapi("en");

      expect(posts[0]?.content).toContain("> **Famous Person**");
      expect(posts[0]?.content).toContain("> This is a quote");
    });

    it("calculates read time based on word count", async () => {
      // 400 words should be 2 min read (200 words per minute)
      const longContent = Array(400).fill("word").join(" ");

      server.use(
        http.get(`${STRAPI_URL}/api/articles`, () => {
          return HttpResponse.json({
            data: [
              {
                id: 1,
                documentId: "doc-1",
                title: "Test",
                description: "Test",
                slug: "test",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                publishedAt: "2024-01-01T00:00:00.000Z",
                blocks: [
                  { __component: "shared.rich-text", id: 1, body: longContent },
                ],
              },
            ],
            meta: {},
          });
        }),
      );

      const { getPostsFromStrapi } = await import("../strapi");
      const posts = await getPostsFromStrapi("en");

      expect(posts[0]?.readTime).toBe("2 min read");
    });

    it("uses description as content when no blocks exist", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/articles`, () => {
          return HttpResponse.json({
            data: [
              {
                id: 1,
                documentId: "doc-1",
                title: "Test",
                description: "This is the description used as content",
                slug: "test",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                publishedAt: "2024-01-01T00:00:00.000Z",
                blocks: [],
              },
            ],
            meta: {},
          });
        }),
      );

      const { getPostsFromStrapi } = await import("../strapi");
      const posts = await getPostsFromStrapi("en");

      expect(posts[0]?.content).toBe("This is the description used as content");
    });
  });
});
