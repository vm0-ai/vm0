import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/cli-auth/"],
        crawlDelay: 1,
      },
    ],
    sitemap: "https://vm0.ai/sitemap.xml",
    host: "https://vm0.ai",
  };
}
