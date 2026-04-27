import type { MetadataRoute } from "next";
import { locales, defaultLocale } from "../i18n";
import { isBlogEnabled } from "../src/env";
import { getPosts, getPostAvailableLocales } from "./lib/blog/data-source";
import { getBlogBaseUrl } from "./lib/blog/config";
import { USE_CASES } from "./[locale]/use-cases/data";
import { MODEL_SLUGS } from "./[locale]/models/data";

const baseUrl = "https://www.vm0.ai";

// Build-time date bumps on every deploy so the sitemap stays fresh without
// anyone having to remember to edit a constant. Marketing pages are generated
// from code, so "last build = last changed" is a reasonable proxy.
const BUILD_DATE = new Date();

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
  // Pre-fetch blog posts once so we can both emit post URLs and derive a
  // realistic lastmod for the /blog index from the most recent post.
  const defaultPosts = isBlogEnabled()
    ? await getPosts(defaultLocale).catch(() => {
        return [];
      })
    : [];

  const latestPostDate = defaultPosts.reduce<Date>((latest, post) => {
    const postDate = new Date(post.publishedAt);
    return postDate > latest ? postDate : latest;
  }, new Date(0));
  const blogIndexLastModified =
    latestPostDate.getTime() > 0 ? latestPostDate : BUILD_DATE;

  const localizedRoutes = [
    {
      path: "",
      priority: 1,
      changeFrequency: "weekly" as const,
      lastModified: BUILD_DATE,
    },
    {
      path: "/pricing",
      priority: 0.9,
      changeFrequency: "monthly" as const,
      lastModified: BUILD_DATE,
    },
    {
      path: "/security",
      priority: 0.8,
      changeFrequency: "monthly" as const,
      lastModified: BUILD_DATE,
    },
    {
      path: "/blog",
      priority: 0.8,
      changeFrequency: "weekly" as const,
      lastModified: blogIndexLastModified,
    },
    {
      path: "/use-cases",
      priority: 0.9,
      changeFrequency: "monthly" as const,
      lastModified: BUILD_DATE,
    },
    {
      path: "/models",
      priority: 0.8,
      changeFrequency: "monthly" as const,
      lastModified: BUILD_DATE,
    },
  ];

  const rootRoutes = [
    {
      path: "/privacy-policy",
      priority: 0.3,
      changeFrequency: "yearly" as const,
      lastModified: BUILD_DATE,
    },
    {
      path: "/terms-of-use",
      priority: 0.3,
      changeFrequency: "yearly" as const,
      lastModified: BUILD_DATE,
    },
    {
      path: "/support",
      priority: 0.5,
      changeFrequency: "monthly" as const,
      lastModified: BUILD_DATE,
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
        lastModified: BUILD_DATE,
        changeFrequency: "monthly",
        priority: 0.7,
        alternates: { languages: alternates },
      });
    }
  }

  // Localized model detail pages
  for (const slug of MODEL_SLUGS) {
    const alternates = buildAlternates(`/models/${slug}`);
    for (const locale of locales) {
      urls.push({
        url: `${baseUrl}/${locale}/models/${slug}`,
        lastModified: BUILD_DATE,
        changeFrequency: "monthly",
        priority: 0.6,
        alternates: { languages: alternates },
      });
    }
  }

  // Blog post pages — only when blog is enabled
  if (defaultPosts.length > 0) {
    const blogBaseUrl = getBlogBaseUrl();

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
