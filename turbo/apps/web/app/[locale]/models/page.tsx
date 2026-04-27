import type { Metadata } from "next";
import { ModelsClient } from "./ModelsClient";
import { MODELS } from "./data";
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
  const url = `${BASE_URL}/${locale}/models`;
  const title = "Models — Run agents on Claude, Kimi, GLM, MiniMax, DeepSeek";
  const description =
    "Every AI model available to VM0 agents — Claude Opus 4.7, Sonnet 4.6, Haiku 4.5, GLM-5.1, Kimi K2.6, MiniMax M2.7, DeepSeek V4. Short intro and what each model is best for on VM0.";

  return {
    title,
    description,
    alternates: buildLocaleAlternates("/models", locale as Locale),
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
          alt: title,
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

export default async function ModelsPage({ params }: PageProps) {
  const { locale } = await params;

  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "AI models available on VM0",
    description:
      "Every AI model available to VM0 agents — Claude, Kimi, GLM, MiniMax, DeepSeek.",
    itemListElement: MODELS.map((m, i) => {
      return {
        "@type": "ListItem",
        position: i + 1,
        name: m.name,
        description: m.cardIntro,
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
        name: "Models",
        item: `${BASE_URL}/${locale}/models`,
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
      <ModelsClient />
    </>
  );
}
