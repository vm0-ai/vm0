import { BlogPost } from "./types";
import {
  getPostsFromStrapi,
  getPostBySlugFromStrapi,
  getFeaturedPostFromStrapi,
  getAllCategoriesFromStrapi,
} from "./strapi";

const DATA_SOURCE = process.env.NEXT_PUBLIC_DATA_SOURCE || "strapi";

export async function getPosts(locale: string = "en"): Promise<BlogPost[]> {
  if (DATA_SOURCE === "strapi") {
    return getPostsFromStrapi(locale);
  }
  return [];
}

export async function getPost(
  slug: string,
  locale: string = "en",
): Promise<BlogPost | null> {
  if (DATA_SOURCE === "strapi") {
    return getPostBySlugFromStrapi(slug, locale);
  }
  return null;
}

export async function getFeatured(
  locale: string = "en",
): Promise<BlogPost | null> {
  if (DATA_SOURCE === "strapi") {
    return getFeaturedPostFromStrapi(locale);
  }
  return null;
}

export async function getCategories(locale: string = "en"): Promise<string[]> {
  if (DATA_SOURCE === "strapi") {
    return getAllCategoriesFromStrapi(locale);
  }
  return [];
}
