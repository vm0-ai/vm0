import { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://vm0.ai";
  const blogUrl = "https://blog.vm0.ai";
  const locales = ["en", "de", "es", "ja"];

  const routes = [
    {
      path: "",
      priority: 1,
      changeFrequency: "weekly" as const,
    },
    {
      path: "/cookbooks",
      priority: 0.9,
      changeFrequency: "weekly" as const,
    },
    {
      path: "/skills",
      priority: 0.9,
      changeFrequency: "weekly" as const,
    },
    {
      path: "/sign-up",
      priority: 0.8,
      changeFrequency: "monthly" as const,
    },
    {
      path: "/sign-in",
      priority: 0.5,
      changeFrequency: "monthly" as const,
    },
  ];

  const urls: MetadataRoute.Sitemap = [];

  // Add main site URLs with locales
  routes.forEach((route) => {
    locales.forEach((locale) => {
      urls.push({
        url: `${baseUrl}/${locale}${route.path}`,
        lastModified: new Date(),
        changeFrequency: route.changeFrequency,
        priority: route.priority,
      });
    });
  });

  // Add blog URLs with locales
  locales.forEach((locale) => {
    urls.push({
      url: `${blogUrl}/${locale}`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    });
  });

  return urls;
}
