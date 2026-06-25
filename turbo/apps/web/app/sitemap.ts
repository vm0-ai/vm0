import type { MetadataRoute } from "next";

const baseUrl = "https://www.vm0.ai";
const BUILD_DATE = new Date();

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
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

  return routes.map((route) => {
    return {
      url: `${baseUrl}${route.path}`,
      lastModified: route.lastModified,
      changeFrequency: route.changeFrequency,
      priority: route.priority,
    };
  });
}
