import { describe, expect, it } from "vitest";
import {
  getBlogBaseUrl,
  getCategories,
  getFeatured,
  getPost,
  getPostAvailableLocales,
  getPosts,
  type BlogPost,
} from "../index";

describe("blog/index", () => {
  it("re-exports the public blog entrypoint surface", () => {
    expect(getPosts).toBeTypeOf("function");
    expect(getPost).toBeTypeOf("function");
    expect(getFeatured).toBeTypeOf("function");
    expect(getCategories).toBeTypeOf("function");
    expect(getPostAvailableLocales).toBeTypeOf("function");
    expect(getBlogBaseUrl).toBeTypeOf("function");

    const examplePost: BlogPost = {
      slug: "test-post",
      title: "Test Post",
      excerpt: "Example excerpt",
      content: "Example content",
      category: "Testing",
      author: { name: "VM0" },
      publishedAt: "2026-04-23T00:00:00.000Z",
      readTime: "1 min read",
      cover: "/cover.png",
    };

    expect(examplePost.slug).toBe("test-post");
  });
});
