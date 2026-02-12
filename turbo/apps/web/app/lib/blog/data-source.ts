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
  return getPostsFromStrapi(locale);
}

export async function getPost(
  slug: string,
  locale: string = "en",
): Promise<BlogPost | null> {
  assertStrapiDataSource();
  return getPostBySlugFromStrapi(slug, locale);
}

export async function getFeatured(
  locale: string = "en",
): Promise<BlogPost | null> {
  assertStrapiDataSource();
  return getFeaturedPostFromStrapi(locale);
}

export async function getCategories(locale: string = "en"): Promise<string[]> {
  assertStrapiDataSource();
  return getAllCategoriesFromStrapi(locale);
}
