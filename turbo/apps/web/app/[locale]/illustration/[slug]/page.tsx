import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { IllustrationDetailClient } from "./IllustrationDetailClient";
import {
  ILLUSTRATION_STYLES,
  getIllustrationBySlug,
  hasDetailPage,
} from "../data";
import { locales, type Locale } from "../../../../i18n";
import { buildLocaleAlternates } from "../../../lib/seo/alternates";

const BASE_URL = "https://www.vm0.ai";
const ASSET_BASE = "https://quiet-moments-gallery-715f6d07.sites.vm0.io";

interface PageProps {
  params: Promise<{ slug: string; locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug, locale } = await params;
  const style = getIllustrationBySlug(slug);

  if (!style || !hasDetailPage(style)) {
    return { title: "Not Found" };
  }

  const t = await getTranslations({ locale, namespace: "illustration" });
  const seoTitle = t(`content.${slug}.seoTitle`);
  const description = t(`content.${slug}.description`);

  return {
    title: `${seoTitle} — VM0`,
    description,
    alternates: buildLocaleAlternates(
      `/illustration/${slug}`,
      locale as Locale,
    ),
    openGraph: {
      title: `${seoTitle} — VM0`,
      description,
      url: `${BASE_URL}/${locale}/illustration/${slug}`,
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title: `${seoTitle} — VM0`,
      description,
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export function generateStaticParams() {
  const params: { slug: string; locale: string }[] = [];

  for (const locale of locales) {
    for (const style of ILLUSTRATION_STYLES) {
      if (hasDetailPage(style)) {
        params.push({ slug: style.slug, locale });
      }
    }
  }

  return params;
}

export default async function IllustrationDetailPage({ params }: PageProps) {
  const { slug, locale } = await params;
  const style = getIllustrationBySlug(slug);

  if (!style || !hasDetailPage(style)) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "illustration" });
  const styleTitle = style.title;
  const seoTitle = t(`content.${slug}.seoTitle`);
  const description = t(`content.${slug}.description`);

  const faq = t.raw(`content.${slug}.faq`) as {
    question: string;
    answer: string;
  }[];

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
      {
        "@type": "ListItem",
        position: 3,
        name: styleTitle,
        item: `${BASE_URL}/${locale}/illustration/${slug}`,
      },
    ],
  };

  const galleryJsonLd = {
    "@context": "https://schema.org",
    "@type": "ImageGallery",
    name: `${styleTitle} — VM0 Illustration Style`,
    description,
    image: style.refs.map((ref) => {
      return `${ASSET_BASE}/refs/${style.slug}/${ref}`;
    }),
  };

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((f) => {
      return {
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: f.answer },
      };
    }),
  };

  const creativeWorkJsonLd = {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    name: styleTitle,
    headline: seoTitle,
    description,
    image: `${ASSET_BASE}/refs/${style.slug}/${style.sample}`,
    creator: {
      "@type": "Organization",
      name: "VM0",
      url: BASE_URL,
    },
  };

  return (
    <>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(breadcrumbJsonLd)}
      </script>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(galleryJsonLd)}
      </script>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(faqJsonLd)}
      </script>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(creativeWorkJsonLd)}
      </script>
      <IllustrationDetailClient style={style} />
    </>
  );
}
