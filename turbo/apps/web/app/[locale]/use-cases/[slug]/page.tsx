import type { Metadata } from "next";
import { notFound } from "next/navigation";
import UseCaseDetailClient from "./UseCaseDetailClient";
import { USE_CASES, getUseCaseBySlug } from "../data";
import { locales } from "../../../../i18n";

const BASE_URL = "https://vm0.ai";

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

  const url = `${BASE_URL}/${locale}/use-cases/${slug}`;

  return {
    title: `${useCase.title} — VM0 Use Case`,
    description: useCase.description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: `${useCase.title} — VM0 Use Case`,
      description: useCase.description,
      url,
      type: "article",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: useCase.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${useCase.title} — VM0 Use Case`,
      description: useCase.description,
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
  const { slug } = await params;
  const useCase = getUseCaseBySlug(slug);

  if (!useCase) {
    notFound();
  }

  const howToJsonLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: useCase.title,
    description: useCase.description,
    step: useCase.steps.map((s, i) => {
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
