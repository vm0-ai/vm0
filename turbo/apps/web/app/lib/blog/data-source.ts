import { BlogPost } from "./types";
import {
  getPostsFromStrapi,
  getPostBySlugFromStrapi,
  getFeaturedPostFromStrapi,
  getAllCategoriesFromStrapi,
} from "./strapi";
import { env } from "../../../src/env";

function getDataSource(): string {
  return env().NEXT_PUBLIC_DATA_SOURCE || "strapi";
}

function assertStrapiDataSource(): void {
  const ds = getDataSource();
  if (ds !== "strapi") {
    throw new Error(
      `Unsupported data source: ${ds}. Only "strapi" is supported.`,
    );
  }
}

export async function getPosts(locale: string = "en"): Promise<BlogPost[]> {
  assertStrapiDataSource();
  try {
    return await getPostsFromStrapi(locale);
  } catch (error) {
    console.error("[blog] Failed to fetch posts:", error);
    return [];
  }
}

export async function getPost(
  slug: string,
  locale: string = "en",
): Promise<BlogPost | null> {
  assertStrapiDataSource();
  try {
    return await getPostBySlugFromStrapi(slug, locale);
  } catch (error) {
    console.error("[blog] Failed to fetch post by slug:", error);
    return null;
  }
}

export async function getFeatured(
  locale: string = "en",
): Promise<BlogPost | null> {
  assertStrapiDataSource();
  try {
    return await getFeaturedPostFromStrapi(locale);
  } catch (error) {
    console.error("[blog] Failed to fetch featured post:", error);
    return null;
  }
}

export async function getCategories(locale: string = "en"): Promise<string[]> {
  assertStrapiDataSource();
  try {
    return await getAllCategoriesFromStrapi(locale);
  } catch (error) {
    console.error("[blog] Failed to fetch categories:", error);
    return [];
  }
}
