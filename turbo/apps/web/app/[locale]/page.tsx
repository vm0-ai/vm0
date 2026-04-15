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
      "Zero, your trustworthy AI teammate for real work. Connects to 100+ tools and does the work — reports, triage, outreach, research — in Slack or on the web.",
    alternates: buildLocaleAlternates("", locale as Locale),
    openGraph: {
      title: "VM0 - Your Trustworthy AI Teammate",
      description:
        "Zero, your trustworthy AI teammate for real work. Connects to 100+ tools and does the work — reports, triage, outreach, research — in Slack or on the web.",
      url,
    },
    twitter: {
      title: "VM0 - Your Trustworthy AI Teammate",
      description:
        "Zero connects to 100+ tools and does the work. Reports, triage, outreach, research. In Slack or on the web.",
    },
  };
}

export default async function Home() {
  const { userId } = await auth();
  return <LandingPage initialIsSignedIn={!!userId} />;
}
