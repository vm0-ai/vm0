import type { Metadata } from "next";
import UseCasesGalleryClient from "./UseCasesGalleryClient";
import { USE_CASES } from "./data";

const BASE_URL = "https://vm0.ai";

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
    alternates: {
      canonical: url,
    },
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

const itemListJsonLd = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: "VM0 Zero Use Cases",
  description: "Real workflows from teams using Zero as their AI teammate.",
  itemListElement: USE_CASES.map((uc, i) => {
    return {
      "@type": "ListItem",
      position: i + 1,
      url: `${BASE_URL}/en/use-cases/${uc.slug}`,
      name: uc.title,
      description: uc.description,
    };
  }),
};

export default function UseCasesPage() {
  return (
    <>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(itemListJsonLd)}
      </script>
      <UseCasesGalleryClient />
    </>
  );
}
