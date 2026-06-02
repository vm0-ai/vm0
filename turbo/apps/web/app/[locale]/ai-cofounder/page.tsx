import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { locales, type Locale } from "../../../i18n";
import { CampaignLanding } from "../../components/CampaignLanding";
import { aiCofounderConfig } from "./data";

interface PageProps {
  params: Promise<{ locale: string }>;
}

// Paid-only landing page: noindex so it never competes with the homepage in
// organic search. Traffic arrives from ads with utm/gclid params, which the
// CTA forwards into the signup -> onboarding -> paywall -> trial flow.
export const metadata: Metadata = {
  title: "Your AI co-founder | VM0",
  description:
    "Zero connects to your tools and does the work. Research, outreach, triage, reporting. In Slack or on the web.",
  robots: { index: false, follow: false },
  alternates: {},
};

export default async function AiCofounderPage({ params }: PageProps) {
  const { locale } = await params;
  if (!locales.includes(locale as Locale)) {
    notFound();
  }

  return <CampaignLanding config={aiCofounderConfig} />;
}
