import type { Metadata } from "next";
import type { Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";
import { PresentationClient } from "./PresentationClient";
import { PRESENTATION_FAQS, PRESENTATION_ITEMS } from "./data";

const BASE_URL = "https://www.vm0.ai";

const PAGE_TITLE =
  "AI Presentation Maker — Generate Beautifully Designed Slide Decks from One Prompt";
const PAGE_DESCRIPTION =
  "VM0's AI presentation maker turns a single prompt into a polished, beautifully designed slide deck. Choose from 60+ world-class design systems, then edit and export to PPTX, PDF, or HTML.";

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const url = `${BASE_URL}/${locale}/presentation`;

  return {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    alternates: buildLocaleAlternates("/presentation", locale as Locale),
    openGraph: {
      title: PAGE_TITLE,
      description: PAGE_DESCRIPTION,
      url,
      type: "website",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: "VM0 AI Presentation Maker",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: PAGE_TITLE,
      description: PAGE_DESCRIPTION,
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export default async function PresentationPage({ params }: PageProps) {
  const { locale } = await params;
  const url = `${BASE_URL}/${locale}/presentation`;

  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "VM0 AI Presentation Maker",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url,
    description: PAGE_DESCRIPTION,
  };

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: PRESENTATION_FAQS.map((faq) => {
      return {
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: faq.answer,
        },
      };
    }),
  };

  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "VM0 Presentation Gallery",
    description: "Slide decks generated with VM0 from a single prompt.",
    itemListElement: PRESENTATION_ITEMS.map((item, i) => {
      return {
        "@type": "ListItem",
        position: i + 1,
        url: `${url}#${item.slug}`,
        name: item.title,
      };
    }),
  };

  return (
    <>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(softwareJsonLd)}
      </script>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(faqJsonLd)}
      </script>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(itemListJsonLd)}
      </script>
      <PresentationClient />
    </>
  );
}
