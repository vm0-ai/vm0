import type { Metadata } from "next";
import type { Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";
import { PresentationClient } from "./PresentationClient";
import { PRESENTATION_ITEMS } from "./data";

const BASE_URL = "https://www.vm0.ai";

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const url = `${BASE_URL}/${locale}/presentation`;

  return {
    title: "Presentation Gallery - Remix Zero Prompts",
    description:
      "Hidden gallery of presentation deck examples for remixing Zero presentation generation.",
    alternates: buildLocaleAlternates("/presentation", locale as Locale),
    robots: {
      index: false,
      follow: false,
    },
    openGraph: {
      title: "VM0 Presentation Gallery",
      description: "Presentation deck examples for remixing Zero generation.",
      url,
      type: "website",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: "VM0 Presentation Gallery",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "VM0 Presentation Gallery",
      description: "Presentation deck examples for remixing Zero generation.",
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export default async function PresentationGalleryPage({ params }: PageProps) {
  const { locale } = await params;
  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "VM0 Presentation Gallery",
    description: "Presentation deck examples for remixing Zero generation.",
    itemListElement: PRESENTATION_ITEMS.map((item, i) => {
      return {
        "@type": "ListItem",
        position: i + 1,
        url: `${BASE_URL}/${locale}/presentation#${item.slug}`,
        name: item.title,
      };
    }),
  };

  return (
    <>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(itemListJsonLd)}
      </script>
      <PresentationClient />
    </>
  );
}
