import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import LandingPage from "../components/LandingPage";
import type { Locale } from "../../i18n";
import { buildLocaleAlternates } from "../lib/seo/alternates";

const BASE_URL = "https://www.vm0.ai";

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const url = `${BASE_URL}/${locale}`;

  return {
    title: "VM0 - Your Trustworthy AI Teammate",
    description:
      "Meet Zero, your AI teammate that runs in secure microVMs. Automate workflows in Slack, GitHub, and the web — with isolated execution, audit trails, and full transparency.",
    alternates: buildLocaleAlternates("", locale as Locale),
    openGraph: {
      title: "VM0 - Your Trustworthy AI Teammate",
      description:
        "Meet Zero, your AI teammate that runs in secure microVMs. Automate workflows in Slack, GitHub, and the web — with isolated execution, audit trails, and full transparency.",
      url,
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: "VM0 - Your Trustworthy AI Teammate",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "VM0 - Your Trustworthy AI Teammate",
      description:
        "Meet Zero, your AI teammate that runs in secure microVMs. Automate workflows in Slack, GitHub, and the web.",
      images: ["/og-image.png"],
    },
  };
}

export default async function Home() {
  const { userId } = await auth();
  return <LandingPage initialIsSignedIn={!!userId} />;
}
