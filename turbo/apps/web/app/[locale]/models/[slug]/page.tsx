import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ModelDetailClient } from "./ModelDetailClient";
import { MODEL_SLUGS, MODELS, getModelBySlug } from "../data";
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
  const model = getModelBySlug(slug);

  if (!model) {
    const t = await getTranslations({ locale, namespace: "models" });
    return { title: t("notFound") };
  }

  const t = await getTranslations({ locale, namespace: "models" });
  const cn = `content.${slug}`;
  const metaTitle = t(`${cn}.metaTitle`);
  const metaDesc = t(`${cn}.metaDescription`);
  const ogImageAlt = t(`${cn}.pageTitle`);
  const url = `${BASE_URL}/${locale}/models/${slug}`;
  const title = `${metaTitle} | VM0`;

  return {
    title,
    description: metaDesc,
    alternates: buildLocaleAlternates(`/models/${slug}`, locale as Locale),
    openGraph: {
      title,
      description: metaDesc,
      url,
      type: "article",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: ogImageAlt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: metaDesc,
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export function generateStaticParams() {
  const params: { slug: string; locale: string }[] = [];
  for (const locale of locales) {
    for (const slug of MODEL_SLUGS) {
      params.push({ slug, locale });
    }
  }
  return params;
}

export default async function ModelDetailPage({ params }: PageProps) {
  const { slug, locale } = await params;
  const model = getModelBySlug(slug);
  const t = await getTranslations({ locale, namespace: "models" });

  if (!model) {
    notFound();
  }

  const cn = `content.${slug}`;
  const related = MODELS.filter((m) => {
    return m.slug !== model.slug;
  }).slice(0, 3);

  const modelName = t(`${cn}.name`);
  const faqs = t.raw(`${cn}.faqs`) as { q: string; a: string }[];

  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${modelName} on VM0`,
    description: t(`${cn}.metaDescription`),
    brand: {
      "@type": "Brand",
      name: model.vendor,
    },
    category: "AI Model",
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: t("breadcrumbHome"),
        item: `${BASE_URL}/${locale}`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: t("breadcrumbModels"),
        item: `${BASE_URL}/${locale}/models`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: modelName,
        item: `${BASE_URL}/${locale}/models/${slug}`,
      },
    ],
  };

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => {
      return {
        "@type": "Question",
        name: faq.q,
        acceptedAnswer: {
          "@type": "Answer",
          text: faq.a,
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
      {faqs.length > 0 && (
        <script type="application/ld+json" suppressHydrationWarning>
          {JSON.stringify(faqJsonLd)}
        </script>
      )}
      <ModelDetailClient model={model} related={related} />
    </>
  );
}
