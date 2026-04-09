import type { MetadataRoute } from "next";
import { isBlogEnabled } from "../src/env";
import { getPosts } from "./lib/blog/data-source";
import { getBlogBaseUrl } from "./lib/blog/config";

const locales = ["en", "de", "es", "ja"];
const baseUrl = "https://vm0.ai";

// Static dates per route category — avoids false "always modified" signals
const STATIC_DATE = new Date("2025-01-01");
const BLOG_DATE = new Date("2025-06-01");

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const localizedRoutes = [
    {
      path: "",
      priority: 1,
      changeFrequency: "weekly" as const,
      lastModified: STATIC_DATE,
    },
    {
      path: "/pricing",
      priority: 0.9,
      changeFrequency: "monthly" as const,
      lastModified: STATIC_DATE,
    },
    {
      path: "/security",
      priority: 0.8,
      changeFrequency: "monthly" as const,
      lastModified: STATIC_DATE,
    },
    {
      path: "/blog",
      priority: 0.8,
      changeFrequency: "weekly" as const,
      lastModified: BLOG_DATE,
    },
  ];

  const rootRoutes = [
    {
      path: "/privacy-policy",
      priority: 0.3,
      changeFrequency: "yearly" as const,
      lastModified: STATIC_DATE,
    },
    {
      path: "/terms-of-use",
      priority: 0.3,
      changeFrequency: "yearly" as const,
      lastModified: STATIC_DATE,
    },
  ];

  const urls: MetadataRoute.Sitemap = [];

  // Localized static pages
  for (const route of localizedRoutes) {
    for (const locale of locales) {
      urls.push({
        url: `${baseUrl}/${locale}${route.path}`,
        lastModified: route.lastModified,
        changeFrequency: route.changeFrequency,
        priority: route.priority,
      });
    }
  }

  // Non-localized legal pages
  for (const route of rootRoutes) {
    urls.push({
      url: `${baseUrl}${route.path}`,
      lastModified: route.lastModified,
      changeFrequency: route.changeFrequency,
      priority: route.priority,
    });
  }

  // Blog post pages — only when blog is enabled
  if (isBlogEnabled()) {
    const blogBaseUrl = getBlogBaseUrl();
    for (const locale of locales) {
      const posts = await getPosts(locale).catch(() => {
        return [];
      });
      for (const post of posts) {
        const imageUrl = post.cover.startsWith("http")
          ? post.cover
          : `${blogBaseUrl}${post.cover}`;
        urls.push({
          url: `${blogBaseUrl}/${locale}/blog/posts/${post.slug}`,
          lastModified: new Date(post.publishedAt),
          changeFrequency: "monthly",
          priority: 0.7,
          images: [imageUrl],
        });
      }
    }
  }

  return urls;
}
