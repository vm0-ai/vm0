import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { UseCasesGalleryClient } from "./UseCasesGalleryClient";
import { USE_CASES } from "./data";
import type { Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";

const BASE_URL = "https://www.vm0.ai";

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const url = `${BASE_URL}/${locale}/use-cases`;

  return {
    title: "Use Cases — See What Zero Can Do",
    description:
      "Real workflows from teams using Zero as their AI teammate. See the exact prompts, outputs, and integrations.",
    alternates: buildLocaleAlternates("/use-cases", locale as Locale),
    openGraph: {
      title: "VM0 Use Cases — See What Zero Can Do",
      description:
        "Real workflows from teams using Zero as their AI teammate. See the exact prompts, outputs, and integrations.",
      url,
      type: "website",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: "VM0 Use Cases",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "VM0 Use Cases — See What Zero Can Do",
      description:
        "Real workflows from teams using Zero as their AI teammate. See the exact prompts, outputs, and integrations.",
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export default async function UseCasesPage({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "useCases" });

  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "VM0 Zero Use Cases",
    description: "Real workflows from teams using Zero as their AI teammate.",
    itemListElement: USE_CASES.map((uc, i) => {
      return {
        "@type": "ListItem",
        position: i + 1,
        url: `${BASE_URL}/${locale}/use-cases/${uc.slug}`,
        name: t(`content.${uc.slug}.title`),
        description: t(`content.${uc.slug}.description`),
      };
    }),
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: `${BASE_URL}/${locale}`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Use Cases",
        item: `${BASE_URL}/${locale}/use-cases`,
      },
    ],
  };

  return (
    <>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(itemListJsonLd)}
      </script>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(breadcrumbJsonLd)}
      </script>
      <UseCasesGalleryClient />
    </>
  );
}
