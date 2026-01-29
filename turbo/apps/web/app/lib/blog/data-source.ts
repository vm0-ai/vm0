import { BlogPost } from "./types";
import {
  getPostsFromStrapi,
  getPostBySlugFromStrapi,
  getFeaturedPostFromStrapi,
  getAllCategoriesFromStrapi,
} from "./strapi";

const DATA_SOURCE = process.env.NEXT_PUBLIC_DATA_SOURCE || "strapi";

function assertStrapiDataSource(dataSource: string): void {
  if (dataSource !== "strapi") {
    throw new Error(
      `Unsupported data source: ${dataSource}. Only "strapi" is supported.`,
    );
  }
}

export async function getPosts(locale: string = "en"): Promise<BlogPost[]> {
  assertStrapiDataSource(DATA_SOURCE);
  return getPostsFromStrapi(locale);
}

export async function getPost(
  slug: string,
  locale: string = "en",
): Promise<BlogPost | null> {
  assertStrapiDataSource(DATA_SOURCE);
  return getPostBySlugFromStrapi(slug, locale);
}

export async function getFeatured(
  locale: string = "en",
): Promise<BlogPost | null> {
  assertStrapiDataSource(DATA_SOURCE);
  return getFeaturedPostFromStrapi(locale);
}

export async function getCategories(locale: string = "en"): Promise<string[]> {
  assertStrapiDataSource(DATA_SOURCE);
  return getAllCategoriesFromStrapi(locale);
}
