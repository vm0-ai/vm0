import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import UseCaseDetailClient from "./UseCaseDetailClient";
import { USE_CASES, getUseCaseBySlug } from "../data";
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
  const useCase = getUseCaseBySlug(slug);

  if (!useCase) {
    return { title: "Not Found" };
  }

  const t = await getTranslations({ locale, namespace: "useCases" });
  const title = t(`content.${slug}.title`);
  const description = t(`content.${slug}.description`);

  const url = `${BASE_URL}/${locale}/use-cases/${slug}`;

  return {
    title: `${title} — VM0 Use Case`,
    description,
    alternates: buildLocaleAlternates(`/use-cases/${slug}`, locale as Locale),
    openGraph: {
      title: `${title} — VM0 Use Case`,
      description,
      url,
      type: "article",
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
      title: `${title} — VM0 Use Case`,
      description,
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export function generateStaticParams() {
  const params: { slug: string; locale: string }[] = [];

  for (const locale of locales) {
    for (const uc of USE_CASES) {
      params.push({ slug: uc.slug, locale });
    }
  }

  return params;
}

export default async function UseCaseDetailPage({ params }: PageProps) {
  const { slug, locale } = await params;
  const useCase = getUseCaseBySlug(slug);

  if (!useCase) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "useCases" });
  const steps = t.raw(`content.${slug}.steps`) as {
    title: string;
    description: string;
  }[];

  const howToJsonLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: t(`content.${slug}.title`),
    description: t(`content.${slug}.description`),
    step: steps.map((s, i) => {
      return {
        "@type": "HowToStep",
        position: i + 1,
        name: s.title,
        text: s.description,
      };
    }),
  };

  return (
    <>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(howToJsonLd)}
      </script>
      <UseCaseDetailClient useCase={useCase} />
    </>
  );
}
