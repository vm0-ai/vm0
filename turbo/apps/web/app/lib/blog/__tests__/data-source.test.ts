import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../src/mocks/server";

const STRAPI_URL = "https://test-strapi.example.com";

// Mock article data
const mockArticle = {
  id: 1,
  documentId: "doc-1",
  title: "Test Post",
  description: "Test excerpt",
  slug: "test-post",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  publishedAt: "2024-01-01T00:00:00.000Z",
  cover: { url: "/covers/test.jpg" },
  author: { name: "Test Author" },
  category: { name: "Technology", slug: "technology" },
  blocks: [{ __component: "shared.rich-text", id: 1, body: "Test content" }],
};

const mockCategories = [
  { id: 1, name: "Technology", slug: "technology" },
  { id: 2, name: "Business", slug: "business" },
  { id: 3, name: "Lifestyle", slug: "lifestyle" },
];

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_STRAPI_URL", STRAPI_URL);
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "strapi");

  // Register base handlers for Strapi API
  server.use(
    // Mock GET /api/articles
    http.get(`${STRAPI_URL}/api/articles`, ({ request }) => {
      const url = new URL(request.url);
      const slug = url.searchParams.get("filters[slug][$eq]");
      const limit = url.searchParams.get("pagination[limit]");

      // If filtering by slug
      if (slug) {
        if (slug === "test-post") {
          return HttpResponse.json({ data: [mockArticle], meta: {} });
        }
        return HttpResponse.json({ data: [], meta: {} });
      }

      // If requesting featured (limit=1)
      if (limit === "1") {
        return HttpResponse.json({ data: [mockArticle], meta: {} });
      }

      // Default: return all articles
      return HttpResponse.json({ data: [mockArticle], meta: {} });
    }),

    // Mock GET /api/categories
    http.get(`${STRAPI_URL}/api/categories`, () => {
      return HttpResponse.json({ data: mockCategories, meta: {} });
    }),
  );
});

describe("blog/data-source", () => {
  describe("getPosts", () => {
    it("fetches posts from strapi and returns transformed data", async () => {
      const { getPosts } = await import("../data-source");
      const posts = await getPosts("en");

      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        slug: "test-post",
        title: "Test Post",
        excerpt: "Test excerpt",
        category: "Technology",
        author: { name: "Test Author" },
      });
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

      const { getPosts } = await import("../data-source");
      await getPosts();

      expect(capturedLocale).toBe("en");
    });

    it("returns empty array when no posts exist", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/articles`, () => {
          return HttpResponse.json({ data: [], meta: {} });
        }),
      );

      const { getPosts } = await import("../data-source");
      const posts = await getPosts("en");

      expect(posts).toEqual([]);
    });
  });

  describe("getPost", () => {
    it("fetches single post by slug from strapi", async () => {
      const { getPost } = await import("../data-source");
      const post = await getPost("test-post", "en");

      expect(post).not.toBeNull();
      expect(post?.slug).toBe("test-post");
      expect(post?.title).toBe("Test Post");
    });

    it("returns null when post not found", async () => {
      const { getPost } = await import("../data-source");
      const post = await getPost("non-existent", "en");

      expect(post).toBeNull();
    });
  });

  describe("getFeatured", () => {
    it("fetches featured post from strapi and marks it as featured", async () => {
      const { getFeatured } = await import("../data-source");
      const post = await getFeatured("en");

      expect(post).not.toBeNull();
      expect(post?.featured).toBe(true);
    });

    it("returns null when no featured post exists", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/articles`, () => {
          return HttpResponse.json({ data: [], meta: {} });
        }),
      );

      const { getFeatured } = await import("../data-source");
      const post = await getFeatured("en");

      expect(post).toBeNull();
    });
  });

  describe("getCategories", () => {
    it("fetches categories from strapi", async () => {
      const { getCategories } = await import("../data-source");
      const categories = await getCategories("en");

      expect(categories).toEqual(["Technology", "Business", "Lifestyle"]);
    });

    it("returns empty array when no categories exist", async () => {
      server.use(
        http.get(`${STRAPI_URL}/api/categories`, () => {
          return HttpResponse.json({ data: [], meta: {} });
        }),
      );

      const { getCategories } = await import("../data-source");
      const categories = await getCategories("en");

      expect(categories).toEqual([]);
    });
  });
});
