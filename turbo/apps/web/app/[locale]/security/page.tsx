import type { Metadata } from "next";
import Script from "next/script";
import SecurityPage from "./SecurityPage";
import type { Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";

const BASE_URL = "https://www.vm0.ai";

interface PageProps {
  params: Promise<{ locale: string }>;
}

function getBreadcrumbJsonLd(locale: string) {
  return {
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
        name: "Security",
        item: `${BASE_URL}/${locale}/security`,
      },
    ],
  };
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const url = `${BASE_URL}/${locale}/security`;

  return {
    title: "Security",
    description:
      "Learn how VM0 keeps your data safe with isolated execution, secret management, full audit trails, and an open-source security model.",
    alternates: buildLocaleAlternates("/security", locale as Locale),
    openGraph: {
      title: "VM0 Security - Built for Trust",
      description:
        "Isolated execution, secret management, audit trails, and open-source transparency.",
      type: "website",
      url,
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: "VM0 Security - Built for Trust",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "VM0 Security - Built for Trust",
      description:
        "Isolated execution, secret management, audit trails, and open-source transparency.",
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export default async function Page({ params }: PageProps) {
  const { locale } = await params;
  const breadcrumbJsonLd = getBreadcrumbJsonLd(locale);

  return (
    <>
      <Script
        id="json-ld-breadcrumb"
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <SecurityPage />
    </>
  );
}
