import type { Metadata } from "next";
import type { Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";
import { GalleryClient } from "./GalleryClient";
import { GALLERY_ITEMS } from "./data";

const BASE_URL = "https://www.vm0.ai";

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const url = `${BASE_URL}/${locale}/gallery`;

  return {
    title: "Generation Gallery - Remix Zero Prompts",
    description:
      "Hidden gallery of prompt-first examples for remixing Zero image, presentation, website, report, video, and audio generation.",
    alternates: buildLocaleAlternates("/gallery", locale as Locale),
    robots: {
      index: false,
      follow: false,
    },
    openGraph: {
      title: "VM0 Generation Gallery",
      description:
        "Prompt-first examples for remixing Zero multimodal generation.",
      url,
      type: "website",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: "VM0 Generation Gallery",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "VM0 Generation Gallery",
      description:
        "Prompt-first examples for remixing Zero multimodal generation.",
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export default async function GalleryPage({ params }: PageProps) {
  const { locale } = await params;
  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "VM0 Generation Gallery",
    description: "Prompt-first examples for remixing Zero generation.",
    itemListElement: GALLERY_ITEMS.map((item, i) => {
      return {
        "@type": "ListItem",
        position: i + 1,
        url: `${BASE_URL}/${locale}/gallery#${item.slug}`,
        name: item.title,
        description: item.description,
      };
    }),
  };

  return (
    <>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(itemListJsonLd)}
      </script>
      <GalleryClient />
    </>
  );
}
