import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BlogPost } from "../types";

// Mock the strapi module
vi.mock("../strapi", () => ({
  getPostsFromStrapi: vi.fn(),
  getPostBySlugFromStrapi: vi.fn(),
  getFeaturedPostFromStrapi: vi.fn(),
  getAllCategoriesFromStrapi: vi.fn(),
}));

describe("blog/data-source", () => {
  const mockPost: BlogPost = {
    slug: "test-post",
    title: "Test Post",
    excerpt: "Test excerpt",
    content: "Test content",
    category: "Technology",
    author: { name: "Test Author" },
    publishedAt: "2024-01-01T00:00:00.000Z",
    readTime: "5 min read",
    cover: "/covers/test.jpg",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getPosts", () => {
    it("delegates to strapi when data source is strapi", async () => {
      const { getPostsFromStrapi } = await import("../strapi");
      vi.mocked(getPostsFromStrapi).mockResolvedValue([mockPost]);

      const { getPosts } = await import("../data-source");
      const posts = await getPosts("en");

      expect(getPostsFromStrapi).toHaveBeenCalledWith("en");
      expect(posts).toEqual([mockPost]);
    });

    it("uses default locale when not provided", async () => {
      const { getPostsFromStrapi } = await import("../strapi");
      vi.mocked(getPostsFromStrapi).mockResolvedValue([]);

      const { getPosts } = await import("../data-source");
      await getPosts();

      expect(getPostsFromStrapi).toHaveBeenCalledWith("en");
    });
  });

  describe("getPost", () => {
    it("delegates to strapi when data source is strapi", async () => {
      const { getPostBySlugFromStrapi } = await import("../strapi");
      vi.mocked(getPostBySlugFromStrapi).mockResolvedValue(mockPost);

      const { getPost } = await import("../data-source");
      const post = await getPost("test-post", "en");

      expect(getPostBySlugFromStrapi).toHaveBeenCalledWith("test-post", "en");
      expect(post).toEqual(mockPost);
    });

    it("returns null when post not found", async () => {
      const { getPostBySlugFromStrapi } = await import("../strapi");
      vi.mocked(getPostBySlugFromStrapi).mockResolvedValue(null);

      const { getPost } = await import("../data-source");
      const post = await getPost("non-existent", "en");

      expect(post).toBeNull();
    });
  });

  describe("getFeatured", () => {
    it("delegates to strapi when data source is strapi", async () => {
      const { getFeaturedPostFromStrapi } = await import("../strapi");
      const featuredPost = { ...mockPost, featured: true };
      vi.mocked(getFeaturedPostFromStrapi).mockResolvedValue(featuredPost);

      const { getFeatured } = await import("../data-source");
      const post = await getFeatured("en");

      expect(getFeaturedPostFromStrapi).toHaveBeenCalledWith("en");
      expect(post).toEqual(featuredPost);
    });

    it("returns null when no featured post exists", async () => {
      const { getFeaturedPostFromStrapi } = await import("../strapi");
      vi.mocked(getFeaturedPostFromStrapi).mockResolvedValue(null);

      const { getFeatured } = await import("../data-source");
      const post = await getFeatured("en");

      expect(post).toBeNull();
    });
  });

  describe("getCategories", () => {
    it("delegates to strapi when data source is strapi", async () => {
      const { getAllCategoriesFromStrapi } = await import("../strapi");
      const categories = ["Technology", "Business", "Lifestyle"];
      vi.mocked(getAllCategoriesFromStrapi).mockResolvedValue(categories);

      const { getCategories } = await import("../data-source");
      const result = await getCategories("en");

      expect(getAllCategoriesFromStrapi).toHaveBeenCalledWith("en");
      expect(result).toEqual(categories);
    });

    it("returns empty array when no categories exist", async () => {
      const { getAllCategoriesFromStrapi } = await import("../strapi");
      vi.mocked(getAllCategoriesFromStrapi).mockResolvedValue([]);

      const { getCategories } = await import("../data-source");
      const result = await getCategories("en");

      expect(result).toEqual([]);
    });
  });
});
