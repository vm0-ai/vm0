import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { LandingPage } from "../components/LandingPage";
import { locales, type Locale } from "../../i18n";
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
      "Zero, your trustworthy AI teammate for real work. Connects to 100+ tools and does the work — reports, triage, outreach, research — in Slack or on the web.",
    alternates: buildLocaleAlternates("", locale as Locale),
    openGraph: {
      type: "website",
      title: "VM0 - Your Trustworthy AI Teammate",
      description:
        "Zero, your trustworthy AI teammate for real work. Connects to 100+ tools and does the work — reports, triage, outreach, research — in Slack or on the web.",
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
        "Zero connects to 100+ tools and does the work. Reports, triage, outreach, research. In Slack or on the web.",
      images: ["/og-image.png"],
      site: "@vm0_ai",
      creator: "@vm0_ai",
    },
  };
}

export default async function Home({ params }: PageProps) {
  // Must short-circuit before auth() because the middleware matcher excludes
  // asset-like paths (e.g. /apple-touch-icon-precomposed.png), so those
  // requests reach this segment without clerkMiddleware having run — calling
  // auth() there throws. The parent layout also calls notFound(), but pages
  // render concurrently with layouts in App Router, so we can race it.
  const { locale } = await params;
  if (!locales.includes(locale as Locale)) {
    notFound();
  }

  const { userId } = await auth();
  return <LandingPage initialIsSignedIn={!!userId} />;
}
