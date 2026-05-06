import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/_next/",
          "/api/",
          "/cli-auth/",
          "/sign-in/",
          "/sign-up/",
          "/sign-in-token/",
          "/export/",
          "/connector/",
        ],
      },
    ],
    sitemap: "https://www.vm0.ai/sitemap.xml",
  };
}
