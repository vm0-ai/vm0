"use client";

import Image from "next/image";
import { IconArrowUpRight } from "@tabler/icons-react";
import { Link } from "../../../../navigation";
import { Footer } from "../../../components/Footer";
import { Particles } from "../../../components/Particles";
import { getAppUrl } from "../../../../src/lib/zero/url";
import type {
  ProviderViewModel,
  ProviderEvaluation,
  EvaluationRating,
} from "../data";

const SCENARIO_LABEL: Record<ProviderEvaluation["scenario"], string> = {
  "tool-routing": "Tool-call routing",
  "long-context": "Long-context recall",
  "code-edit": "Code-edit precision",
  "agent-loop": "Agent loop stability",
  "cost-efficiency": "Cost efficiency",
};

const RATING_LABEL: Record<EvaluationRating, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
};

const RATING_CLASS: Record<EvaluationRating, string> = {
  excellent: "mp-rating mp-rating--excellent",
  good: "mp-rating mp-rating--good",
  fair: "mp-rating mp-rating--fair",
};

function ProviderHeroLogo({ provider }: { provider: ProviderViewModel }) {
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
        className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[14px] text-[22px] font-semibold text-white"
        style={{ backgroundColor: provider.visual.accent }}
      >
        {initials}
      </div>
    );
  }

  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[14px] bg-[hsl(var(--gray-50))] p-3">
      <Image
        src={provider.visual.logo}
        alt={`${provider.displayName} logo`}
        width={36}
        height={36}
        className={`h-9 w-9 object-contain${provider.visual.darkInvertLogo ? " landing-icon-invert" : ""}`}
      />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="uc-section">
      <h2 className="uc-section-title" style={{ marginBottom: 16 }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

interface Props {
  provider: ProviderViewModel;
  related: ProviderViewModel[];
}

export function ProviderDetailClient({ provider, related }: Props) {
  const platformUrl = getAppUrl();
  const { content } = provider;

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <Particles />

      <main className="px-6 pb-20 pt-[calc(var(--total-header-height)+48px)] md:pb-28 md:pt-[calc(var(--total-header-height)+72px)]">
        <article className="mx-auto max-w-[800px]">
          <Link href="/model-providers" className="uc-detail-back">
            &larr; All model providers
          </Link>

          <header style={{ marginBottom: 40 }}>
            <div className="flex items-start gap-4">
              <ProviderHeroLogo provider={provider} />
              <div className="min-w-0 flex-1">
                <span className="text-[12px] font-semibold uppercase tracking-[1.5px] text-[#ed4e01]">
                  Model provider
                </span>
                <h1 className="mt-2 text-[32px] font-semibold leading-[1.15] tracking-tight sm:text-[40px]">
                  {content.detailHeading}
                </h1>
              </div>
            </div>

            <p className="mt-6 text-[16px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
              {content.intro}
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <a
                href={platformUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-xl bg-[#ed4e01] px-5 py-2.5 text-[14px] font-semibold text-white shadow-sm transition-colors hover:bg-[#d64601]"
              >
                Connect {provider.displayName}
                <IconArrowUpRight size={16} />
              </a>
              <Link
                href="/use-cases"
                className="inline-flex items-center gap-2 rounded-xl border border-[hsl(var(--gray-300))] px-5 py-2.5 text-[14px] font-medium text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--gray-50))]"
              >
                See VM0 use cases
              </Link>
            </div>
          </header>

          {/* Available models */}
          {provider.models.length > 0 && (
            <Section title="Available models">
              <div className="mp-model-grid">
                {provider.models.map((model) => {
                  const isDefault = provider.defaultModel === model;
                  return (
                    <div key={model} className="mp-model-card">
                      <div className="flex items-center justify-between gap-2">
                        <code className="mp-model-name">{model}</code>
                        {isDefault && (
                          <span className="mp-tag mp-tag--accent">Default</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Strengths */}
          {content.strengths.length > 0 && (
            <Section title="What this provider is good at">
              <ul className="mp-bullets">
                {content.strengths.map((s) => {
                  return (
                    <li key={s} className="mp-bullet">
                      <span className="mp-bullet-dot" aria-hidden="true" />
                      <span>{s}</span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          {/* Tradeoffs */}
          {content.tradeoffs.length > 0 && (
            <Section title="Honest tradeoffs">
              <ul className="mp-bullets">
                {content.tradeoffs.map((t) => {
                  return (
                    <li key={t} className="mp-bullet mp-bullet--muted">
                      <span
                        className="mp-bullet-dot mp-bullet-dot--muted"
                        aria-hidden="true"
                      />
                      <span>{t}</span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          {/* Evaluation */}
          {content.evaluation.length > 0 && (
            <Section title="How it performs in VM0">
              <div className="mp-eval-list">
                {content.evaluation.map((e) => {
                  return (
                    <div key={e.scenario} className="mp-eval-item">
                      <div className="flex items-center justify-between gap-3">
                        <span className="mp-eval-scenario">
                          {SCENARIO_LABEL[e.scenario]}
                        </span>
                        <span className={RATING_CLASS[e.rating]}>
                          {RATING_LABEL[e.rating]}
                        </span>
                      </div>
                      <p className="mt-2 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
                        {e.notes}
                      </p>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* When to choose */}
          {content.whenToChoose && (
            <Section title={`When to choose ${provider.displayName}`}>
              <p className="uc-section-body">{content.whenToChoose}</p>
            </Section>
          )}

          {/* Setup */}
          <Section title="Setup">
            <ol className="mp-setup">
              <li className="mp-setup-step">
                <span className="mp-setup-num">1</span>
                <div>
                  <div className="mp-setup-title">
                    Get a {provider.displayName} key
                  </div>
                  <div className="mp-setup-desc">
                    {content.bestFor === "default"
                      ? "VM0 Managed needs no key — skip to step 3."
                      : `Sign in to ${provider.displayName} and generate an API key. The provider's setup link appears in the VM0 connect dialog.`}
                  </div>
                </div>
              </li>
              <li className="mp-setup-step">
                <span className="mp-setup-num">2</span>
                <div>
                  <div className="mp-setup-title">
                    Open VM0 Settings → Model Providers
                  </div>
                  <div className="mp-setup-desc">
                    Click <em>Connect a provider</em>, choose{" "}
                    <strong>{provider.contractLabel}</strong>, paste your key,
                    and save.
                  </div>
                </div>
              </li>
              <li className="mp-setup-step">
                <span className="mp-setup-num">3</span>
                <div>
                  <div className="mp-setup-title">
                    Pick the model on your agent
                  </div>
                  <div className="mp-setup-desc">
                    Open the agent, switch its model to{" "}
                    {provider.defaultModel ? (
                      <code>{provider.defaultModel}</code>
                    ) : (
                      "your chosen model"
                    )}
                    , and run.
                  </div>
                </div>
              </li>
            </ol>
          </Section>

          {/* Security */}
          <Section title="Security & key isolation">
            <p className="uc-section-body">
              Your {provider.displayName} key never enters the agent sandbox.
              VM0 stores it encrypted at the platform layer and the firewall
              injects an authorization header on outbound LLM calls — so even
              shell-out tools cannot exfiltrate the credential.
            </p>
            <Link
              href="/security"
              className="mt-2 inline-flex items-center gap-1 text-[14px] font-medium text-[#ed4e01] transition-all hover:gap-2"
            >
              Read about VM0 security &rarr;
            </Link>
          </Section>

          {/* FAQ */}
          {content.faqs.length > 0 && (
            <Section title="Frequently asked questions">
              <div className="mp-detail-faq">
                {content.faqs.map((faq) => {
                  return (
                    <div key={faq.question} className="mp-detail-faq-item">
                      <h3 className="mp-detail-faq-q">{faq.question}</h3>
                      <p className="mp-detail-faq-a">{faq.answer}</p>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Related providers */}
          {related.length > 0 && (
            <div className="uc-related">
              <h2 className="uc-related-title">Other supported providers</h2>
              <div className="uc-related-grid">
                {related.map((p) => {
                  return (
                    <Link
                      key={p.slug}
                      href={`/model-providers/${p.slug}`}
                      className="uc-related-card"
                    >
                      <div className="uc-related-card-title">
                        {p.displayName}
                      </div>
                      <div className="uc-related-card-desc">
                        {p.content.tagline}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </article>
      </main>

      <Footer />
    </div>
  );
}
