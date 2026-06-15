import type { Metadata } from "next";
import { Fraunces } from "next/font/google";
import type { Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";
import { illustrationAssetUrl, ILLUSTRATION_STYLES } from "@vm0/core";
import { IllustrationGalleryClient } from "./IllustrationGalleryClient";

const BASE_URL = "https://www.vm0.ai";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["italic"],
  variable: "--font-fraunces",
  display: "swap",
  preload: false,
});

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const url = `${BASE_URL}/${locale}/illustration`;
  const title = "Illustration — VM0";
  const description =
    "An open gallery of every illustration style in the vm0-skills register. Each plate shows one piece in that style with every AI variation behind it.";

  return {
    title,
    description,
    alternates: buildLocaleAlternates("/illustration", locale as Locale),
    openGraph: {
      title,
      description,
      url,
      type: "website",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: "VM0 Illustration",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export default async function IllustrationPage({ params }: PageProps) {
  const { locale } = await params;

  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "VM0 Illustration Gallery",
    description:
      "Gallery of every illustration style in the vm0-skills register.",
    itemListElement: ILLUSTRATION_STYLES.map((style, i) => {
      return {
        "@type": "ListItem",
        position: i + 1,
        name: style.title,
        image: illustrationAssetUrl(`images/${style.image}`),
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
        name: "Illustration",
        item: `${BASE_URL}/${locale}/illustration`,
      },
    ],
  };

  return (
    <div className={fraunces.variable}>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(itemListJsonLd)}
      </script>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(breadcrumbJsonLd)}
      </script>
      <IllustrationGalleryClient />
    </div>
  );
}
