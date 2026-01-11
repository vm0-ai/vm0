import { MetadataRoute } from "next";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://docs.vm0.ai";

  const pages = source.getPages();

  const urls: MetadataRoute.Sitemap = pages.map((page) => ({
    url: `${baseUrl}${page.url}`,
    changeFrequency: "weekly",
    priority: page.slugs.length === 0 ? 1.0 : 0.8,
  }));

  return urls;
}
