"use client";

import { IconArrowRight } from "@tabler/icons-react";
import { Link } from "../../../../navigation";
import { Footer } from "../../../components/Footer";
import { Particles } from "../../../components/Particles";
import { getAppUrl } from "../../../../src/lib/zero/url";
import { MODELS, type ModelEntry, vendorIconPath } from "../data";

const MAX_WIDTH = 880;
const PAGE_PADDING = 24;

function formatUsd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function formatContextWindow(k: number): string {
  if (k >= 1000) return `${(k / 1000).toFixed(0)}M tokens`;
  return `${k}K tokens`;
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="uc-section">
      <h2
        className="uc-section-title"
        style={{ marginBottom: subtitle ? 8 : 20 }}
      >
        {title}
      </h2>
      {subtitle && (
        <p
          className="text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]"
          style={{ marginBottom: 24 }}
        >
          {subtitle}
        </p>
      )}
      {children}
    </section>
  );
}

function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl bg-white p-6 sm:p-8 ${className}`}>
      {children}
    </div>
  );
}

function DataRow({
  label,
  value,
  last,
}: {
  label: string;
  value: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`flex flex-wrap items-baseline justify-between gap-4 py-3.5${last ? "" : " border-b border-[hsl(var(--gray-100))]"}`}
    >
      <span className="text-[14px] text-[hsl(var(--muted-foreground))]">
        {label}
      </span>
      <span className="text-[15px] text-[hsl(var(--foreground))]">{value}</span>
    </div>
  );
}

function altName(slug: string): string {
  const m = MODELS.find((x) => {
    return x.slug === slug;
  });
  return m ? m.name : slug;
}

function inlineCode(text: string): React.ReactNode {
  const parts = text.split(/`([^`]+)`/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      return (
        <code
          key={i}
          className="rounded bg-[hsl(var(--gray-100))] px-1.5 py-0.5 font-mono text-[0.88em] text-[hsl(var(--foreground))]"
        >
          {part}
        </code>
      );
    }
    return part;
  });
}

function multiplierPositioning(name: string, m: number): string {
  if (m === 1) {
    return `${name} sits at the ×1 baseline that every other Built-in model is priced against, so it's the unit you compare costs in when picking between models on VM0.`;
  }
  if (m > 1) {
    return `${name} bills at ×${m}, which means a step here costs ${m}× the credits of an equivalent step on Sonnet 4.6 (the ×1 baseline). It's a premium tier on VM0, so the cost-effective pattern is to default to a cheaper model and route only the steps that genuinely need the extra reasoning depth to ${name}.`;
  }
  if (m <= 0.05) {
    return `${name} bills at ×${m}, which means a step here costs only ${m}× the credits of an equivalent step on Sonnet 4.6 (the ×1 baseline). That puts it at the cheapest tier of the Built-in catalogue and makes it the obvious choice when unit cost dominates the decision and the workload is largely single-shot.`;
  }
  return `${name} bills at ×${m}, which means a step here costs only ${m}× the credits of an equivalent step on Sonnet 4.6 (the ×1 baseline). That puts it well below the credit baseline and makes it the natural pick for high-volume background work where cost-per-step matters more than peak reasoning quality.`;
}

function tierExplanation(name: string, tier: ModelEntry["vm0Tier"]): string {
  if (tier === "core") {
    return `VM0 positions ${name} as a core agent model, recommended alongside Claude Opus 4.7, Claude Opus 4.6, and Claude Sonnet 4.6 for the steps that drive the actual outcome of an agent run. These are the models we'd pick for the orchestrator role, for code-touching agents, and for any step where a wrong answer is expensive.`;
  }
  return `VM0 positions ${name} as a cost-saving option rather than a core agent model. Use it to optimise unit cost on non-core work, such as bulk classification, pre-filters, latency-critical short replies, or pinned legacy agents, while keeping Claude Opus 4.7, Claude Opus 4.6, or Claude Sonnet 4.6 on the steps that decide the run.`;
}

interface Props {
  model: ModelEntry;
  related: ModelEntry[];
}

export function ModelDetailClient({ model, related }: Props) {
  const platformUrl = getAppUrl();

  const heroMeta = [
    formatContextWindow(model.contextWindowK),
    model.modalities.join(" / "),
    model.chinaAccessible ? "China-accessible" : "Global",
    model.promptCaching ? "Prompt cache" : null,
  ].filter(Boolean);

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <Particles />

      <main className="pb-20 pt-[calc(var(--total-header-height)+48px)] md:pb-28 md:pt-[calc(var(--total-header-height)+72px)]">
        <article
          className="mx-auto"
          style={{ maxWidth: MAX_WIDTH, padding: `0 ${PAGE_PADDING}px` }}
        >
          <Link href="/models" className="uc-detail-back">
            &larr; All models
          </Link>

          {/* Hero */}
          <header style={{ marginBottom: 56 }}>
            {vendorIconPath(model.vendor) && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={vendorIconPath(model.vendor) ?? ""}
                alt=""
                width={48}
                height={48}
                className="mb-5 shrink-0 rounded-lg"
              />
            )}
            <h1 className="text-[32px] font-semibold leading-[1.15] tracking-tight sm:text-[40px]">
              {model.pageTitle}
            </h1>
            <p className="mt-5 text-[17px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
              {model.tagline}
            </p>

            <p className="mt-6 text-[14px] text-[hsl(var(--muted-foreground))]">
              {heroMeta.join("  ·  ")}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href={platformUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-get-access group"
              >
                <span>Use {model.name} on VM0</span>
                <IconArrowRight
                  size={16}
                  className="transition-transform group-hover:translate-x-0.5"
                />
              </a>
            </div>
          </header>

          {/* TL;DR */}
          <Card className="mb-12">
            <div className="flex flex-col gap-4">
              {model.summary.split("\n\n").map((para, i) => {
                return (
                  <p
                    key={i}
                    className="text-[16px] leading-relaxed text-[hsl(var(--foreground))]"
                  >
                    {inlineCode(para)}
                  </p>
                );
              })}
            </div>
          </Card>

          {/* Overview */}
          <Section title={`What is ${model.name}?`}>
            <p className="mb-6 text-[14px] text-[hsl(var(--muted-foreground))]">
              Released {model.releaseDate} · {model.familyPosition}
            </p>
            <div className="flex flex-col gap-4">
              {model.background.map((para, i) => {
                return (
                  <p
                    key={i}
                    className="text-[16px] leading-relaxed text-[hsl(var(--foreground))]"
                  >
                    {inlineCode(para)}
                  </p>
                );
              })}
            </div>
          </Section>

          {/* What's notable */}
          {model.architecture && (
            <Section
              title={`What's notable about ${model.name}`}
              subtitle="Headline architecture and capability features."
            >
              <p className="text-[16px] leading-relaxed text-[hsl(var(--foreground))]">
                {inlineCode(model.architecture)}
              </p>
            </Section>
          )}

          {/* Specs */}
          <Section title="Specs at a glance">
            <Card>
              {model.specs.map((row, i) => {
                return (
                  <DataRow
                    key={row.label}
                    label={row.label}
                    value={row.value}
                    last={i === model.specs.length - 1}
                  />
                );
              })}
            </Card>
          </Section>

          {/* Benchmarks */}
          {model.benchmarks.length > 0 && (
            <Section
              title={`${model.name} benchmarks`}
              subtitle={model.benchmarksNote}
            >
              <Card>
                {model.benchmarks.map((b, i) => {
                  const last = i === model.benchmarks.length - 1;
                  return (
                    <div
                      key={b.name}
                      className={`flex items-center justify-between gap-4 py-3.5${last ? "" : " border-b border-[hsl(var(--gray-100))]"}`}
                    >
                      <div className="flex flex-col">
                        <span className="text-[15px] text-[hsl(var(--foreground))]">
                          {b.name}
                        </span>
                        {b.note && (
                          <span className="mt-0.5 text-[13px] text-[hsl(var(--muted-foreground))]">
                            {b.note}
                          </span>
                        )}
                      </div>
                      <span className="text-[15px] font-medium text-[hsl(var(--foreground))]">
                        {b.score}
                      </span>
                    </div>
                  );
                })}
              </Card>
            </Section>
          )}

          {/* Pricing */}
          <Section
            title={`${model.name} pricing`}
            subtitle="Provider list price, per 1M tokens."
          >
            <Card>
              <DataRow
                label="Input"
                value={formatUsd(model.pricing.inputUsd)}
              />
              <DataRow
                label="Output"
                value={formatUsd(model.pricing.outputUsd)}
              />
              <DataRow
                label="Cache read"
                value={formatUsd(model.pricing.cacheReadUsd)}
              />
              <DataRow
                label="Cache write"
                value={
                  model.pricing.cacheWriteUsd === null
                    ? "Not billed"
                    : formatUsd(model.pricing.cacheWriteUsd)
                }
                last
              />
            </Card>
          </Section>

          {/* Performance */}
          <Section
            title={`How ${model.name} behaves in practice`}
            subtitle="Observed behaviour from production agent runs."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {model.performance.map((note) => {
                return (
                  <Card key={note.title} className="!p-6">
                    <h3 className="text-[18px] font-medium text-[hsl(var(--foreground))]">
                      {note.title}
                    </h3>
                    <p className="mt-2 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
                      {inlineCode(note.body)}
                    </p>
                  </Card>
                );
              })}
            </div>
          </Section>

          {/* Best agent tasks */}
          <Section title={`Best agent tasks for ${model.name}`}>
            <div className="flex flex-col gap-4">
              {model.bestForExamples.map((ex) => {
                return (
                  <Card key={ex.title} className="!p-6">
                    <h3 className="text-[18px] font-medium text-[hsl(var(--foreground))]">
                      {ex.title}
                    </h3>
                    <p className="mt-2 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
                      {inlineCode(ex.body)}
                    </p>
                  </Card>
                );
              })}
            </div>
          </Section>

          {/* Skip when */}
          {model.avoidFor && (
            <Section title={`When to skip ${model.name}`}>
              <p className="text-[16px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                {inlineCode(model.avoidFor)}
              </p>
            </Section>
          )}

          {/* Comparisons */}
          {model.comparisons.length > 0 && (
            <Section title={`${model.name} vs other models`}>
              <div className="flex flex-col gap-4">
                {model.comparisons.map((cmp) => {
                  return (
                    <Card key={cmp.vs} className="!p-6">
                      <h3 className="text-[18px] font-medium text-[hsl(var(--foreground))]">
                        {model.name} vs {cmp.vs}
                      </h3>
                      <p className="mt-2 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
                        {inlineCode(cmp.body)}
                      </p>
                    </Card>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Verdict */}
          {model.verdict && (
            <Section title={`Bottom line: should you use ${model.name}?`}>
              <div className="rounded-2xl border-l-[3px] border-[#ed4e01] bg-white p-6 sm:p-8">
                <p className="text-[16px] leading-relaxed text-[hsl(var(--foreground))]">
                  {inlineCode(model.verdict)}
                </p>
              </div>
            </Section>
          )}

          {/* FAQ */}
          {model.faqs.length > 0 && (
            <Section title="Frequently asked questions">
              <div className="flex flex-col gap-7">
                {model.faqs.map((faq) => {
                  return (
                    <div key={faq.q}>
                      <h3 className="text-[18px] font-medium text-[hsl(var(--foreground))]">
                        {faq.q}
                      </h3>
                      <p className="mt-2 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
                        {inlineCode(faq.a)}
                      </p>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Alternatives */}
          {model.alternatives.length > 0 && (
            <Section title="Alternatives">
              <div className="grid gap-3 sm:grid-cols-2">
                {model.alternatives.map((alt) => {
                  return (
                    <Link
                      key={alt.slug}
                      href={`/models/${alt.slug}`}
                      className="block rounded-2xl bg-white p-5 transition-all hover:-translate-y-0.5"
                    >
                      <div className="text-[15px] font-medium text-[hsl(var(--foreground))]">
                        {altName(alt.slug)}
                      </div>
                      <div className="mt-1 text-[14px] font-light text-[hsl(var(--muted-foreground))]">
                        {alt.reason}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Using on VM0 — final dedicated section */}
          <Section title={`Using ${model.name} on VM0`}>
            <div className="flex flex-col gap-5">
              <div>
                <h3 className="text-[18px] font-medium text-[hsl(var(--foreground))]">
                  Two ways to access {model.name} on VM0
                </h3>
                <p className="mt-2 text-[16px] leading-relaxed text-[hsl(var(--foreground))]">
                  VM0 supports {model.name} as a Built-in model billed in VM0
                  credits, and through bring-your-own with a {model.byoKeyLabel}
                  . The Built-in path uses VM0 Managed routing and the credit
                  multiplier explained below; the bring-your-own path bills you
                  directly with the upstream vendor and skips the VM0 credit
                  conversion entirely.
                </p>
              </div>

              <div>
                <h3 className="text-[18px] font-medium text-[hsl(var(--foreground))]">
                  VM0&rsquo;s recommendation
                </h3>
                <p className="mt-2 text-[16px] leading-relaxed text-[hsl(var(--foreground))]">
                  {tierExplanation(model.name, model.vm0Tier)}
                </p>
              </div>

              <div>
                <h3 className="text-[18px] font-medium text-[hsl(var(--foreground))]">
                  Credits and the ×{model.multiplier} multiplier
                </h3>
                <p className="mt-2 text-[16px] leading-relaxed text-[hsl(var(--foreground))]">
                  Every Built-in model on VM0 is priced as a multiple of Claude
                  Sonnet 4.6, which sits at the ×1 credit baseline. {model.name}{" "}
                  bills at ×{model.multiplier} credits. The multiplier is what
                  shows up on your VM0 invoice; the vendor list price in the
                  pricing table above is what the upstream provider charges
                  before VM0 converts it into credits.
                </p>
                <p className="mt-3 text-[16px] leading-relaxed text-[hsl(var(--foreground))]">
                  {multiplierPositioning(model.name, model.multiplier)}
                </p>
              </div>

              <p className="text-[14px] text-[hsl(var(--muted-foreground))]">
                Available on VM0 since {model.releasedToVm0}.
              </p>
            </div>
          </Section>

          {/* Related */}
          <div className="uc-related">
            <h2 className="uc-related-title">More models on VM0</h2>
            <div className="uc-related-grid">
              {related.map((m) => {
                return (
                  <Link
                    key={m.slug}
                    href={`/models/${m.slug}`}
                    className="uc-related-card"
                  >
                    <div className="uc-related-card-title">{m.name}</div>
                    <div className="uc-related-card-desc">{m.cardIntro}</div>
                  </Link>
                );
              })}
            </div>
          </div>
        </article>
      </main>

      <Footer />
    </div>
  );
}
