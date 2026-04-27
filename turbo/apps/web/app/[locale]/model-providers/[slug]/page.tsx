import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProviderDetailClient } from "./ProviderDetailClient";
import { PROVIDER_SLUGS, getProvider, getOrderedProviders } from "../data";
import { locales, type Locale } from "../../../../i18n";
import { buildLocaleAlternates } from "../../../lib/seo/alternates";

const BASE_URL = "https://www.vm0.ai";

interface PageProps {
  params: Promise<{ slug: string; locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug, locale } = await params;
  const provider = getProvider(slug);

  if (!provider) {
    return { title: "Not Found" };
  }

  const url = `${BASE_URL}/${locale}/model-providers/${slug}`;
  const title = `${provider.content.detailHeading} — VM0`;

  return {
    title,
    description: provider.content.metaDescription,
    alternates: buildLocaleAlternates(
      `/model-providers/${slug}`,
      locale as Locale,
    ),
    openGraph: {
      title,
      description: provider.content.metaDescription,
      url,
      type: "article",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: provider.content.detailHeading,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: provider.content.metaDescription,
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export function generateStaticParams() {
  const params: { slug: string; locale: string }[] = [];
  for (const locale of locales) {
    for (const slug of PROVIDER_SLUGS) {
      params.push({ slug, locale });
    }
  }
  return params;
}

export default async function ProviderDetailPage({ params }: PageProps) {
  const { slug, locale } = await params;
  const provider = getProvider(slug);

  if (!provider) {
    notFound();
  }

  const allProviders = getOrderedProviders();
  const related = allProviders
    .filter((p) => {
      return p.slug !== provider.slug;
    })
    .slice(0, 3);

  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${provider.displayName} on VM0`,
    description: provider.content.metaDescription,
    brand: {
      "@type": "Brand",
      name: provider.displayName,
    },
    category: "AI Model Provider",
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
        name: "Model Providers",
        item: `${BASE_URL}/${locale}/model-providers`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: provider.displayName,
        item: `${BASE_URL}/${locale}/model-providers/${slug}`,
      },
    ],
  };

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: provider.content.faqs.map((faq) => {
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

  return (
    <>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(productJsonLd)}
      </script>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(breadcrumbJsonLd)}
      </script>
      {provider.content.faqs.length > 0 && (
        <script type="application/ld+json" suppressHydrationWarning>
          {JSON.stringify(faqJsonLd)}
        </script>
      )}
      <ProviderDetailClient provider={provider} related={related} />
    </>
  );
}
