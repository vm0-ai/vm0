import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import type { Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";
import { IllustrationGalleryClient } from "./IllustrationGalleryClient";
import { ILLUSTRATION_STYLES } from "./data";

const BASE_URL = "https://www.vm0.ai";
const ASSET_BASE = "https://quiet-moments-gallery-715f6d07.sites.vm0.io";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
  preload: false,
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-inter",
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
    "Quiet Moments — an editorial gallery showing every illustration style in the vm0-skills register. Twenty-two plates, one brief, each with its full set of AI variations.";

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
      "Editorial gallery of every illustration style in the vm0-skills register.",
    itemListElement: ILLUSTRATION_STYLES.map((style, i) => {
      return {
        "@type": "ListItem",
        position: i + 1,
        name: style.title,
        image: `${ASSET_BASE}/images/${style.image}`,
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
    <div className={`${fraunces.variable} ${inter.variable}`}>
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
