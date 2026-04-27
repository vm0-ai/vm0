import type { Metadata } from "next";
import { ModelProvidersHubClient } from "./ModelProvidersHubClient";
import { getOrderedProviders } from "./data";
import type { Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";

const BASE_URL = "https://www.vm0.ai";

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const url = `${BASE_URL}/${locale}/model-providers`;
  const title = "AI Model Providers Supported by VM0";
  const description =
    "Run AI agents on Claude, Kimi, DeepSeek, GLM, MiniMax and more — bring your own API key or use VM0 Managed. Compare quality, cost, and region for every supported provider.";

  return {
    title,
    description,
    alternates: buildLocaleAlternates("/model-providers", locale as Locale),
    openGraph: {
      title,
      description,
      url,
      type: "website",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export default async function ModelProvidersPage({ params }: PageProps) {
  const { locale } = await params;
  const providers = getOrderedProviders();

  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "AI Model Providers Supported by VM0",
    description:
      "Run AI agents on Claude, Kimi, DeepSeek, GLM, MiniMax and more — bring your own API key or use VM0 Managed.",
    itemListElement: providers.map((p, i) => {
      return {
        "@type": "ListItem",
        position: i + 1,
        url: `${BASE_URL}/${locale}/model-providers/${p.slug}`,
        name: p.displayName,
        description: p.content.tagline,
      };
    }),
  };

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
        name: "Model Providers",
        item: `${BASE_URL}/${locale}/model-providers`,
      },
    ],
  };

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Which AI model providers does VM0 support?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "VM0 supports Anthropic (Claude Opus 4.7, Sonnet 4.6, Haiku 4.5), Claude Code OAuth, OpenRouter, Moonshot (Kimi K2.6 and K2.5 Thinking), MiniMax (M2.7), DeepSeek (V4 Pro and V4 Flash), Z.AI (GLM-5.1 and the GLM family), and Vercel AI Gateway. VM0 Managed pools many of these for zero-setup access.",
        },
      },
      {
        "@type": "Question",
        name: "Can I switch model providers without rewriting my agent?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. All supported providers expose an Anthropic-compatible API surface, so VM0 routes existing agents to a different provider by changing one setting — no agent code changes are required.",
        },
      },
      {
        "@type": "Question",
        name: "Does VM0 store my model provider API keys?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Your provider keys are stored encrypted at the platform layer and never enter the agent sandbox. The VM0 firewall injects the authorization header on outbound LLM calls so the sandbox cannot read your credentials.",
        },
      },
      {
        "@type": "Question",
        name: "Are Chinese model providers (Kimi, GLM, MiniMax, DeepSeek) supported?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. VM0 supports Moonshot (Kimi), Z.AI (GLM), MiniMax, and DeepSeek directly, plus access to all four through OpenRouter or VM0 Managed. All are reachable from mainland China without a proxy.",
        },
      },
      {
        "@type": "Question",
        name: "Which provider should I start with?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Start with VM0 Managed if you want zero setup. Choose Anthropic direct if you want maximum quality and prompt-cache savings. Pick DeepSeek or GLM if cost dominates the decision. Choose Moonshot or MiniMax if your users are in China.",
        },
      },
    ],
  };

  return (
    <>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(itemListJsonLd)}
      </script>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(breadcrumbJsonLd)}
      </script>
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(faqJsonLd)}
      </script>
      <ModelProvidersHubClient providers={providers} />
    </>
  );
}
