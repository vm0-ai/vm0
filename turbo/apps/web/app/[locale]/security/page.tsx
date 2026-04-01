import type { Metadata } from "next";
import SecurityPage from "./SecurityPage";

const BASE_URL = "https://vm0.ai";

interface PageProps {
  params: Promise<{ locale: string }>;
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
    alternates: {
      canonical: url,
    },
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

export default function Page() {
  return <SecurityPage />;
}
