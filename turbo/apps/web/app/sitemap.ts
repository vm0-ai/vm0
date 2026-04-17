import type { MetadataRoute } from "next";
import { isBlogEnabled } from "../src/env";
import { getPosts, getPostAvailableLocales } from "./lib/blog/data-source";
import { getBlogBaseUrl } from "./lib/blog/config";
import { USE_CASES } from "./[locale]/use-cases/data";

const locales = ["en", "de", "es", "ja"] as const;
const defaultLocale = "en";
const baseUrl = "https://www.vm0.ai";

// Static dates per route category — avoids false "always modified" signals
const STATIC_DATE = new Date("2025-01-01");
const BLOG_DATE = new Date("2025-06-01");

/**
 * Build hreflang alternates map for a localized path.
 * Includes x-default pointing to the default-locale version.
 */
function buildAlternates(
  localeLessPath: string,
  availableLocales: readonly string[] = locales,
): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const loc of availableLocales) {
    languages[loc] = `${baseUrl}/${loc}${localeLessPath}`;
  }
  languages["x-default"] = `${baseUrl}/${defaultLocale}${localeLessPath}`;
  return languages;
}

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
    {
      path: "/use-cases",
      priority: 0.9,
      changeFrequency: "monthly" as const,
      lastModified: STATIC_DATE,
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
    {
      path: "/support",
      priority: 0.5,
      changeFrequency: "monthly" as const,
      lastModified: STATIC_DATE,
    },
  ];

  const urls: MetadataRoute.Sitemap = [];

  // Localized static pages — one entry per locale with hreflang alternates
  for (const route of localizedRoutes) {
    const alternates = buildAlternates(route.path);
    for (const locale of locales) {
      urls.push({
        url: `${baseUrl}/${locale}${route.path}`,
        lastModified: route.lastModified,
        changeFrequency: route.changeFrequency,
        priority: route.priority,
        alternates: { languages: alternates },
      });
    }
  }

  // Non-localized legal pages (no hreflang — single-language)
  for (const route of rootRoutes) {
    urls.push({
      url: `${baseUrl}${route.path}`,
      lastModified: route.lastModified,
      changeFrequency: route.changeFrequency,
      priority: route.priority,
    });
  }

  // Localized use-case detail pages
  for (const useCase of USE_CASES) {
    const alternates = buildAlternates(`/use-cases/${useCase.slug}`);
    for (const locale of locales) {
      urls.push({
        url: `${baseUrl}/${locale}/use-cases/${useCase.slug}`,
        lastModified: STATIC_DATE,
        changeFrequency: "monthly",
        priority: 0.7,
        alternates: { languages: alternates },
      });
    }
  }

  // Blog post pages — only when blog is enabled
  if (isBlogEnabled()) {
    const blogBaseUrl = getBlogBaseUrl();

    // Collect unique slugs from default locale, then check each slug's
    // available translations to avoid emitting URLs that would 404.
    const defaultPosts = await getPosts(defaultLocale).catch(() => {
      return [];
    });

    for (const post of defaultPosts) {
      const available = await getPostAvailableLocales(post.slug, locales);
      if (available.length === 0) continue;

      const alternates = buildAlternates(`/blog/posts/${post.slug}`, available);

      const imageUrl = post.cover.startsWith("http")
        ? post.cover
        : `${blogBaseUrl}${post.cover}`;

      for (const locale of available) {
        urls.push({
          url: `${baseUrl}/${locale}/blog/posts/${post.slug}`,
          lastModified: new Date(post.publishedAt),
          changeFrequency: "monthly",
          priority: 0.7,
          images: [imageUrl],
          alternates: { languages: alternates },
        });
      }
    }
  }

  return urls;
}
