import type { Metadata } from "next";
import type { Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";
import { PresentationDesignClient } from "./PresentationDesignClient";
import { PRESENTATION_GALLERY_ITEMS } from "./data";

const BASE_URL = "https://www.vm0.ai";

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const url = `${BASE_URL}/${locale}/presentation-design`;

  return {
    title: "Presentation Design Gallery - Remix Zero Prompts",
    description:
      "Hidden gallery of presentation design examples for remixing Zero presentation generation.",
    alternates: buildLocaleAlternates("/presentation-design", locale as Locale),
    robots: {
      index: false,
      follow: false,
    },
    openGraph: {
      title: "VM0 Presentation Design Gallery",
      description: "Presentation design examples for remixing Zero generation.",
      url,
      type: "website",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: "VM0 Presentation Design Gallery",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "VM0 Presentation Design Gallery",
      description: "Presentation design examples for remixing Zero generation.",
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
    name: "VM0 Presentation Design Gallery",
    description: "Presentation design examples for remixing Zero generation.",
    itemListElement: PRESENTATION_GALLERY_ITEMS.map((item, i) => {
      return {
        "@type": "ListItem",
        position: i + 1,
        url: `${BASE_URL}/${locale}/presentation-design#${item.slug}`,
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
      <PresentationDesignClient locale={locale} />
    </>
  );
}
