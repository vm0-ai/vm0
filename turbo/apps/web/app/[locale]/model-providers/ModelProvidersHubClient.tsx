"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { Link } from "../../../navigation";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import type { ProviderViewModel } from "./data";

const MAX_WIDTH = 1200;
const PAGE_PADDING = 24;

type FilterValue =
  | "all"
  | "default"
  | "max-quality"
  | "cost-optimised"
  | "china-region"
  | "long-context"
  | "personal-pro"
  | "gateway"
  | "specialised";

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All providers" },
  { value: "default", label: "Default" },
  { value: "max-quality", label: "Max quality" },
  { value: "cost-optimised", label: "Cost-optimised" },
  { value: "china-region", label: "China region" },
  { value: "long-context", label: "Long context" },
  { value: "gateway", label: "Gateway" },
  { value: "personal-pro", label: "Personal Pro/Max" },
];

const COST_BAND_LABEL: Record<string, string> = {
  "free-with-plan": "Included",
  $: "$",
  $$: "$$",
  $$$: "$$$",
  $$$$: "$$$$",
};

function ProviderLogo({ provider }: { provider: ProviderViewModel }) {
  const initials = provider.displayName
    .split(/[\s-]+/u)
    .slice(0, 2)
    .map((word) => {
      return word[0] ?? "";
    })
    .join("")
    .toUpperCase();

  if (!provider.visual.logo) {
    return (
      <div
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[10px] text-base font-semibold text-white"
        style={{ backgroundColor: provider.visual.accent }}
      >
        {initials}
      </div>
    );
  }

  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-[hsl(var(--gray-50))] p-2">
      <Image
        src={provider.visual.logo}
        alt={`${provider.displayName} logo`}
        width={28}
        height={28}
        className={`h-7 w-7 object-contain${provider.visual.darkInvertLogo ? " landing-icon-invert" : ""}`}
      />
    </div>
  );
}

function ProviderCard({ provider }: { provider: ProviderViewModel }) {
  return (
    <Link
      href={`/model-providers/${provider.slug}`}
      className="mp-card group"
      aria-label={`Read about ${provider.displayName} on VM0`}
    >
      <div className="flex items-start gap-4">
        <ProviderLogo provider={provider} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-medium tracking-[-0.2px] text-[hsl(var(--foreground))] group-hover:text-[#ed4e01]">
              {provider.displayName}
            </h3>
            {provider.content.bestFor === "default" && (
              <span className="mp-tag mp-tag--accent">Default</span>
            )}
          </div>
          <span className="text-[13px] font-medium uppercase tracking-[1px] text-[hsl(var(--muted-foreground))]">
            {provider.content.authLabel}
          </span>
        </div>
      </div>

      <p className="mt-4 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
        {provider.content.tagline}
      </p>

      {provider.models.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {provider.models.slice(0, 4).map((model) => {
            return (
              <span key={model} className="mp-tag mp-tag--model">
                {model}
              </span>
            );
          })}
          {provider.models.length > 4 && (
            <span className="mp-tag mp-tag--model">
              +{provider.models.length - 4}
            </span>
          )}
        </div>
      )}

      <div className="mt-5 flex items-center gap-2 text-[13px] text-[hsl(var(--muted-foreground))]">
        <span>{COST_BAND_LABEL[provider.content.costBand]}</span>
        <span aria-hidden="true">·</span>
        <span>
          {provider.content.chinaAccessible
            ? "China-accessible"
            : "Outside China"}
        </span>
      </div>

      <span className="mt-5 inline-flex items-center gap-1 text-[14px] font-medium text-[#ed4e01] transition-all group-hover:gap-2">
        See details
        <span aria-hidden="true">→</span>
      </span>
    </Link>
  );
}

function ComparisonRow({ provider }: { provider: ProviderViewModel }) {
  const topModel = provider.defaultModel ?? provider.models[0] ?? "—";
  return (
    <tr className="mp-matrix-row">
      <td>
        <Link
          href={`/model-providers/${provider.slug}`}
          className="mp-matrix-name"
        >
          {provider.displayName}
        </Link>
      </td>
      <td className="mp-matrix-mono">{topModel}</td>
      <td>{provider.content.authLabel}</td>
      <td>{COST_BAND_LABEL[provider.content.costBand]}</td>
      <td>{provider.content.chinaAccessible ? "✓" : "—"}</td>
      <td className="mp-matrix-bestfor">{filterLabel(provider.content.bestFor)}</td>
    </tr>
  );
}

function filterLabel(value: string): string {
  const match = FILTERS.find((f) => {
    return f.value === value;
  });
  return match ? match.label : value;
}

function HowWeEvaluate() {
  const items: { title: string; description: string }[] = [
    {
      title: "Tool-call routing accuracy",
      description:
        "Does the agent pick the correct connector and call it with the correct arguments? Measured against a fixed VM0 evaluation suite covering Slack, GitHub, Linear, and Notion flows.",
    },
    {
      title: "Long-context recall",
      description:
        "At 100k+ tokens of run history, does the model still recall earlier tool outputs and stay coherent? Tested on real long-running agent transcripts.",
    },
    {
      title: "Code-edit precision",
      description:
        "For code-touching agents, does the first patch attempt apply cleanly and pass tests? Measured on a fixed bug-fix benchmark.",
    },
    {
      title: "Agent loop stability",
      description:
        "Average steps to completion, retry rate, and drift rate across multi-step runs. Lower is better.",
    },
    {
      title: "Cost per completed run",
      description:
        "Production-measured cost from VM0 telemetry on representative agent tasks — not synthetic per-token pricing.",
    },
  ];

  return (
    <div className="mp-method-grid">
      {items.map((item) => {
        return (
          <div key={item.title} className="mp-method-card">
            <h3 className="text-[16px] font-medium text-[hsl(var(--foreground))]">
              {item.title}
            </h3>
            <p className="mt-2 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
              {item.description}
            </p>
          </div>
        );
      })}
    </div>
  );
}

const FAQS = [
  {
    q: "Which AI model providers does VM0 support?",
    a: "VM0 supports Anthropic (Claude Opus 4.7, Sonnet 4.6, Haiku 4.5), Claude Code OAuth, OpenRouter, Moonshot (Kimi K2.6 and K2.5 Thinking), MiniMax (M2.7), DeepSeek (V4 Pro and V4 Flash), Z.AI (GLM-5.1 and the GLM family), and Vercel AI Gateway. VM0 Managed pools many of these for zero-setup access.",
  },
  {
    q: "Can I switch model providers without rewriting my agent?",
    a: "Yes. All supported providers expose an Anthropic-compatible API surface, so VM0 routes existing agents to a different provider by changing one setting — no agent code changes required.",
  },
  {
    q: "Does VM0 store my model provider API keys?",
    a: "Your provider keys are stored encrypted at the platform layer and never enter the agent sandbox. The VM0 firewall injects the authorization header on outbound LLM calls so the sandbox cannot read your credentials.",
  },
  {
    q: "Are Chinese model providers (Kimi, GLM, MiniMax, DeepSeek) supported?",
    a: "Yes. VM0 supports Moonshot (Kimi), Z.AI (GLM), MiniMax, and DeepSeek directly, plus access to all four through OpenRouter or VM0 Managed. All are reachable from mainland China without a proxy.",
  },
  {
    q: "Which provider should I start with?",
    a: "Start with VM0 Managed if you want zero setup. Choose Anthropic direct if you want maximum quality and prompt-cache savings. Pick DeepSeek or GLM if cost dominates the decision. Choose Moonshot or MiniMax if your users are in China.",
  },
];

function FaqList() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  return (
    <div className="mp-faq-list">
      {FAQS.map((faq, idx) => {
        const isOpen = openIndex === idx;
        return (
          <div key={faq.q} className="mp-faq-item">
            <button
              type="button"
              className="mp-faq-question"
              aria-expanded={isOpen}
              onClick={() => {
                setOpenIndex(isOpen ? null : idx);
              }}
            >
              <span>{faq.q}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                aria-hidden="true"
                className={`mp-faq-chev${isOpen ? " mp-faq-chev--open" : ""}`}
              >
                <path
                  d="M3 5l4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <div
              className={`mp-faq-answer${isOpen ? " mp-faq-answer--open" : ""}`}
            >
              <p>{faq.a}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  providers: ProviderViewModel[];
}

export function ModelProvidersHubClient({ providers }: Props) {
  const [filter, setFilter] = useState<FilterValue>("all");

  const visibleProviders = useMemo(() => {
    if (filter === "all") return providers;
    return providers.filter((p) => {
      return p.content.bestFor === filter;
    });
  }, [providers, filter]);

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <Particles />

      {/* Hero */}
      <section className="hero-section" style={{ paddingBottom: "40px" }}>
        <div className="container">
          <h1 className="hero-title">
            AI model providers supported by VM0
          </h1>
          <p className="hero-description">
            Run agents on Claude, Kimi, DeepSeek, GLM, MiniMax and more. Bring
            your own API key — or skip setup with VM0 Managed.
          </p>
        </div>
      </section>

      {/* Filter row */}
      <section style={{ paddingBottom: 24 }}>
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
        >
          <div
            className="uc-filter-row"
            role="tablist"
            aria-label="Filter providers"
          >
            {FILTERS.map((option) => {
              const isActive = filter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`uc-pill${isActive ? " uc-pill--active" : ""}`}
                  onClick={() => {
                    setFilter(option.value);
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Provider grid */}
      <section style={{ paddingBottom: 80 }}>
        <div className="mp-grid">
          {visibleProviders.map((provider) => {
            return <ProviderCard key={provider.slug} provider={provider} />;
          })}
          {visibleProviders.length === 0 && (
            <div className="mp-empty">
              No providers match this filter. Try “All providers”.
            </div>
          )}
        </div>
      </section>

      {/* Comparison matrix */}
      <section style={{ paddingBottom: 80 }}>
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
        >
          <h2 className="mp-section-heading">Compare every supported provider</h2>
          <p className="mp-section-sub">
            One row per provider. Click a row to read VM0&rsquo;s evaluation,
            supported models, and setup steps.
          </p>
          <div className="mp-matrix-wrap">
            <table className="mp-matrix">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Default model</th>
                  <th>Auth</th>
                  <th>Cost band</th>
                  <th>China</th>
                  <th>Best for</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((provider) => {
                  return (
                    <ComparisonRow key={provider.slug} provider={provider} />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Methodology */}
      <section style={{ paddingBottom: 80 }}>
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
        >
          <h2 className="mp-section-heading">How VM0 evaluates a provider</h2>
          <p className="mp-section-sub">
            Five criteria, each measured on real agent runs — not synthetic
            benchmarks.
          </p>
          <HowWeEvaluate />
        </div>
      </section>

      {/* FAQ */}
      <section style={{ paddingBottom: 120 }}>
        <div
          style={{
            maxWidth: 800,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
        >
          <h2 className="mp-section-heading">Frequently asked questions</h2>
          <FaqList />
        </div>
      </section>

      <Footer />
    </div>
  );
}
