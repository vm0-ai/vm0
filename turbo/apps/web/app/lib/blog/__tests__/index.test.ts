import { describe, expect, it } from "vitest";
import {
  getBlogBaseUrl,
  getCategories,
  getFeatured,
  getPost,
  getPostAvailableLocales,
  getPosts,
} from "../index";

describe("blog/index", () => {
  it("re-exports the public blog entrypoint surface", () => {
    expect(getPosts).toBeTypeOf("function");
    expect(getPost).toBeTypeOf("function");
    expect(getFeatured).toBeTypeOf("function");
    expect(getCategories).toBeTypeOf("function");
    expect(getPostAvailableLocales).toBeTypeOf("function");
    expect(getBlogBaseUrl).toBeTypeOf("function");
  });
});
