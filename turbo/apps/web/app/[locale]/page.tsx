import type { Metadata } from "next";
import LandingPage from "../components/LandingPage";

const BASE_URL = "https://vm0.ai";

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
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: "VM0 - Your Trustworthy AI Teammate",
      description:
        "Meet Zero, your AI teammate that runs in secure microVMs. Automate workflows in Slack, GitHub, and the web — with isolated execution, audit trails, and full transparency.",
      url,
    },
    twitter: {
      title: "VM0 - Your Trustworthy AI Teammate",
      description:
        "Meet Zero, your AI teammate that runs in secure microVMs. Automate workflows in Slack, GitHub, and the web.",
    },
  };
}

export default function Home() {
  return <LandingPage />;
}
