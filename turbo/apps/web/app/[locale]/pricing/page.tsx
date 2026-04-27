import type { Metadata } from "next";
import { PricingPageClient } from "./PricingPageClient";
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
        name: "Pricing",
        item: `${BASE_URL}/${locale}/pricing`,
      },
    ],
  };
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const url = `${BASE_URL}/${locale}/pricing`;

  return {
    title: "Pricing",
    description:
      "Start free with VM0. Pay only for what you use — 10,000 starter credits, no credit card required. Upgrade to Pro or Team as you scale.",
    alternates: buildLocaleAlternates("/pricing", locale as Locale),
    openGraph: {
      title: "VM0 Pricing — Pay for What You Use",
      description:
        "Start free with VM0. Pay only for what you use — 10,000 starter credits, no credit card required. Upgrade to Pro or Team as you scale.",
      url,
      type: "website",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: "VM0 Pricing",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "VM0 Pricing — Pay for What You Use",
      description:
        "Start free with VM0. Pay only for what you use — 10,000 starter credits, no credit card required.",
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

const faqItems = [
  {
    question: "What are credits?",
    answer:
      "Credits are consumed when your agents use AI models. Different models consume credits at different rates. For example, a simple task might use a few credits, while a complex multi-step workflow uses more.",
  },
  {
    question: "Can I change plans at any time?",
    answer:
      "Yes! You can upgrade or downgrade your plan at any time. When you upgrade, leftover credits remain in your account with their original expiration date and are used first. Changes take effect immediately.",
  },
  {
    question: "What happens when I run out of credits?",
    answer:
      "When your credits are depleted, your agents will stop running. You can purchase additional credits via auto-recharge, upgrade to a higher plan for more monthly credits, or buy pay-as-you-go credits that never expire.",
  },
  {
    question: "Do credits expire?",
    answer:
      "Yes. Every credit has an expiration date. Free plan: 10,000 starter credits expire 1 month after signup and do not refresh. Pro/Team plans: credits are granted each billing cycle and expire 1 month after the billing date. Pay-as-you-go credits: never expire. Promotion credits: one-time credits with a set expiration date.",
  },
  {
    question: "What happens to my credits when I upgrade?",
    answer:
      "When you upgrade (Free to Pro, or Pro to Team), leftover credits from your current plan remain in your account and are used first. They keep their original expiration date and expire as originally scheduled.",
  },
  {
    question: "Can I bring my own model provider?",
    answer:
      "Yes! All plans support bringing your own LLM API keys (Anthropic, etc.). When using your own keys, no VM0 credits are consumed for model usage.",
  },
  {
    question: "How secure is VM0?",
    answer:
      "Every agent run executes in an isolated Firecracker microVM with hardware-level KVM isolation. Credentials are injected at the network layer and never exposed to agent code. All agent HTTP/HTTPS traffic is logged with SHA-256 integrity per run.",
  },
  {
    question: "Do you offer annual billing or discounts?",
    answer:
      "Contact us to discuss volume pricing, annual billing discounts, and custom arrangements for your team.",
  },
];

const pricingJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "VM0",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web, Linux, macOS, Windows",
  url: "https://www.vm0.ai",
  offers: [
    {
      "@type": "Offer",
      name: "Free",
      price: "0",
      priceCurrency: "USD",
      description:
        "10,000 starter credits (expire in 1 month), 1 agent at a time, community support",
    },
    {
      "@type": "Offer",
      name: "Pro",
      price: "20",
      priceCurrency: "USD",
      billingIncrement: "month",
      description:
        "20,000 credits/month, 2 concurrent agents, priority support, credits expire after 1 month",
    },
    {
      "@type": "Offer",
      name: "Team",
      price: "200",
      priceCurrency: "USD",
      billingIncrement: "month",
      description:
        "120,000 credits/month, 5 concurrent agents, dedicated support, team management",
    },
  ],
};

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqItems.map(({ question, answer }) => {
    return {
      "@type": "Question",
      name: question,
      acceptedAnswer: {
        "@type": "Answer",
        text: answer,
      },
    };
  }),
};

export default async function PricingPage({ params }: PageProps) {
  const { locale } = await params;
  const breadcrumbJsonLd = getBreadcrumbJsonLd(locale);

  return (
    <>
      <script
        id="json-ld-breadcrumb"
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <script
        id="json-ld-pricing"
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(pricingJsonLd) }}
      />
      <script
        id="json-ld-faq"
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <PricingPageClient />
    </>
  );
}
