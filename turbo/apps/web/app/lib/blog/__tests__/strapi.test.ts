import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("blog/strapi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_STRAPI_URL", "https://test-strapi.example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getPostsFromStrapi", () => {
    it("fetches posts and transforms them correctly", async () => {
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

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockArticles, meta: {} }),
      });

      const { getPostsFromStrapi } = await import("../strapi");
      const posts = await getPostsFromStrapi("en");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://test-strapi.example.com/api/articles?locale=en&populate=*&sort=publishedAt:desc",
        { next: { revalidate: 60 } },
      );

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
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const { getPostsFromStrapi } = await import("../strapi");

      await expect(getPostsFromStrapi("en")).rejects.toThrow(
        "Failed to fetch posts: 500 Internal Server Error",
      );
    });

    it("uses default locale when not provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [], meta: {} }),
      });

      const { getPostsFromStrapi } = await import("../strapi");
      await getPostsFromStrapi();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("locale=en"),
        expect.anything(),
      );
    });

    it("handles articles without optional fields", async () => {
      const mockArticles = [
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
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockArticles, meta: {} }),
      });

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
      const mockArticle = {
        id: 1,
        documentId: "doc-1",
        title: "Single Post",
        description: "Single post description",
        slug: "single-post",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        publishedAt: "2024-01-01T00:00:00.000Z",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [mockArticle], meta: {} }),
      });

      const { getPostBySlugFromStrapi } = await import("../strapi");
      const post = await getPostBySlugFromStrapi("single-post", "en");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://test-strapi.example.com/api/articles?locale=en&filters[slug][$eq]=single-post&populate=*",
        { next: { revalidate: 60 } },
      );

      expect(post).not.toBeNull();
      expect(post?.slug).toBe("single-post");
    });

    it("returns null when post not found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [], meta: {} }),
      });

      const { getPostBySlugFromStrapi } = await import("../strapi");
      const post = await getPostBySlugFromStrapi("non-existent", "en");

      expect(post).toBeNull();
    });

    it("throws error when fetch fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const { getPostBySlugFromStrapi } = await import("../strapi");

      await expect(getPostBySlugFromStrapi("test", "en")).rejects.toThrow(
        "Failed to fetch post by slug: 404 Not Found",
      );
    });
  });

  describe("getFeaturedPostFromStrapi", () => {
    it("fetches featured post and marks it as featured", async () => {
      const mockArticle = {
        id: 1,
        documentId: "doc-1",
        title: "Featured Post",
        description: "Featured description",
        slug: "featured-post",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        publishedAt: "2024-01-01T00:00:00.000Z",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [mockArticle], meta: {} }),
      });

      const { getFeaturedPostFromStrapi } = await import("../strapi");
      const post = await getFeaturedPostFromStrapi("en");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("pagination[limit]=1"),
        expect.anything(),
      );

      expect(post).not.toBeNull();
      expect(post?.featured).toBe(true);
    });

    it("returns null when no posts exist", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [], meta: {} }),
      });

      const { getFeaturedPostFromStrapi } = await import("../strapi");
      const post = await getFeaturedPostFromStrapi("en");

      expect(post).toBeNull();
    });

    it("throws error when fetch fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });

      const { getFeaturedPostFromStrapi } = await import("../strapi");

      await expect(getFeaturedPostFromStrapi("en")).rejects.toThrow(
        "Failed to fetch featured post: 503 Service Unavailable",
      );
    });
  });

  describe("getAllCategoriesFromStrapi", () => {
    it("fetches and returns category names", async () => {
      const mockCategories = [
        { id: 1, name: "Technology", slug: "technology" },
        { id: 2, name: "Business", slug: "business" },
        { id: 3, name: "Lifestyle", slug: "lifestyle" },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockCategories, meta: {} }),
      });

      const { getAllCategoriesFromStrapi } = await import("../strapi");
      const categories = await getAllCategoriesFromStrapi("en");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://test-strapi.example.com/api/categories?locale=en",
        { next: { revalidate: 60 } },
      );

      expect(categories).toEqual(["Technology", "Business", "Lifestyle"]);
    });

    it("returns empty array when no categories exist", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [], meta: {} }),
      });

      const { getAllCategoriesFromStrapi } = await import("../strapi");
      const categories = await getAllCategoriesFromStrapi("en");

      expect(categories).toEqual([]);
    });

    it("throws error when fetch fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const { getAllCategoriesFromStrapi } = await import("../strapi");

      await expect(getAllCategoriesFromStrapi("en")).rejects.toThrow(
        "Failed to fetch categories: 500 Internal Server Error",
      );
    });
  });

  describe("article transformation", () => {
    it("handles relative cover URLs by prepending STRAPI_URL", async () => {
      const mockArticle = {
        id: 1,
        documentId: "doc-1",
        title: "Test",
        description: "Test",
        slug: "test",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        publishedAt: "2024-01-01T00:00:00.000Z",
        cover: { url: "/uploads/image.jpg" },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [mockArticle], meta: {} }),
      });

      const { getPostsFromStrapi } = await import("../strapi");
      const posts = await getPostsFromStrapi("en");

      expect(posts[0]?.cover).toBe(
        "https://test-strapi.example.com/uploads/image.jpg",
      );
    });

    it("transforms shared.quote blocks correctly", async () => {
      const mockArticle = {
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
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [mockArticle], meta: {} }),
      });

      const { getPostsFromStrapi } = await import("../strapi");
      const posts = await getPostsFromStrapi("en");

      expect(posts[0]?.content).toContain("> **Famous Person**");
      expect(posts[0]?.content).toContain("> This is a quote");
    });

    it("calculates read time based on word count", async () => {
      // 400 words should be 2 min read (200 words per minute)
      const longContent = Array(400).fill("word").join(" ");
      const mockArticle = {
        id: 1,
        documentId: "doc-1",
        title: "Test",
        description: "Test",
        slug: "test",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        publishedAt: "2024-01-01T00:00:00.000Z",
        blocks: [{ __component: "shared.rich-text", id: 1, body: longContent }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [mockArticle], meta: {} }),
      });

      const { getPostsFromStrapi } = await import("../strapi");
      const posts = await getPostsFromStrapi("en");

      expect(posts[0]?.readTime).toBe("2 min read");
    });

    it("uses description as content when no blocks exist", async () => {
      const mockArticle = {
        id: 1,
        documentId: "doc-1",
        title: "Test",
        description: "This is the description used as content",
        slug: "test",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        publishedAt: "2024-01-01T00:00:00.000Z",
        blocks: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [mockArticle], meta: {} }),
      });

      const { getPostsFromStrapi } = await import("../strapi");
      const posts = await getPostsFromStrapi("en");

      expect(posts[0]?.content).toBe("This is the description used as content");
    });
  });

  describe("environment configuration", () => {
    it("throws when NEXT_PUBLIC_STRAPI_URL is not configured", async () => {
      vi.unstubAllEnvs();

      await expect(import("../strapi")).rejects.toThrow(
        "NEXT_PUBLIC_STRAPI_URL environment variable is not configured",
      );
    });
  });
});
