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
  options: { draft?: boolean } = {},
): Promise<BlogPost | null> {
  assertStrapiDataSource();
  return getPostBySlugFromStrapi(slug, locale, options);
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

/**
 * Return the subset of supported locales that have a published translation for
 * the given blog post slug.  Used to build accurate hreflang alternates so we
 * never point crawlers at a 404 page.
 */
export async function getPostAvailableLocales(
  slug: string,
  supportedLocales: readonly string[],
): Promise<string[]> {
  const results = await Promise.all(
    supportedLocales.map(async (loc) => {
      const post = await getPost(slug, loc).catch(() => {
        return null;
      });
      return post ? loc : null;
    }),
  );
  return results.filter((loc): loc is string => {
    return loc !== null;
  });
}
