import type { Metadata } from "next";

export const baseUrl = new URL(
  process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "https://docs.vm0.ai",
);

export function createMetadata(override: Metadata): Metadata {
  return {
    ...override,
    openGraph: {
      title: override.title ?? undefined,
      description: override.description ?? undefined,
      url: baseUrl.toString(),
      images: "/og-image.png",
      siteName: "VM0 Docs",
      type: "website",
      ...override.openGraph,
    },
    twitter: {
      card: "summary_large_image",
      creator: "@vm0_ai",
      title: override.title ?? undefined,
      description: override.description ?? undefined,
      images: "/og-image.png",
      ...override.twitter,
    },
  };
}

export function getPageImageUrl(slugs: string[]): string {
  return `/og/${[...slugs, "og.png"].join("/")}`;
}
