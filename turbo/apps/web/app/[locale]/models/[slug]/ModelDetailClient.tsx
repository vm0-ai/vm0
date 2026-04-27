"use client";

import { Link } from "../../../../navigation";
import { Footer } from "../../../components/Footer";
import { Particles } from "../../../components/Particles";
import { getAppUrl } from "../../../../src/lib/zero/url";
import { MODELS, type ModelEntry } from "../data";

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
        style={{ marginBottom: subtitle ? 8 : 16 }}
      >
        {title}
      </h2>
      {subtitle && (
        <p
          className="text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]"
          style={{ marginBottom: 20 }}
        >
          {subtitle}
        </p>
      )}
      {children}
    </section>
  );
}

function Badge({
  label,
  value,
  tone = "default",
}: {
  label?: string;
  value: string;
  tone?: "default" | "accent";
}) {
  const toneClass =
    tone === "accent"
      ? "border-[#ed4e01]/20 bg-[#ed4e01]/8 text-[#ed4e01]"
      : "border-[hsl(var(--gray-200))] bg-[hsl(var(--gray-50))] text-[hsl(var(--foreground))]";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium ${toneClass}`}
    >
      {label && (
        <span className="text-[hsl(var(--muted-foreground))]">{label}</span>
      )}
      <span>{value}</span>
    </span>
  );
}

function FactRow({
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
      className={`flex flex-wrap items-baseline justify-between gap-3 py-3${last ? "" : " border-b border-[hsl(var(--gray-200))]"}`}
    >
      <span className="text-[13px] font-medium uppercase tracking-[1.2px] text-[hsl(var(--muted-foreground))]">
        {label}
      </span>
      <span className="text-[15px] text-[hsl(var(--foreground))]">{value}</span>
    </div>
  );
}

function PriceRow({
  label,
  value,
  last,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between px-5 py-3 text-[15px]${last ? "" : " border-b border-[hsl(var(--gray-200))]"}`}
    >
      <span className="text-[hsl(var(--muted-foreground))]">{label}</span>
      <span className="font-medium text-[hsl(var(--foreground))]">
        {value}{" "}
        <span className="text-[13px] font-normal text-[hsl(var(--muted-foreground))]">
          / 1M tokens
        </span>
      </span>
    </div>
  );
}

function altName(slug: string): string {
  const m = MODELS.find((x) => {
    return x.slug === slug;
  });
  return m ? m.name : slug;
}

interface Props {
  model: ModelEntry;
  related: ModelEntry[];
}

export function ModelDetailClient({ model, related }: Props) {
  const platformUrl = getAppUrl();

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <Particles />

      <main className="px-6 pb-20 pt-[calc(var(--total-header-height)+48px)] md:pb-28 md:pt-[calc(var(--total-header-height)+72px)]">
        <article
          className="mx-auto"
          style={{ maxWidth: MAX_WIDTH, padding: `0 ${PAGE_PADDING}px` }}
        >
          <Link href="/models" className="uc-detail-back">
            &larr; All models
          </Link>

          {/* Hero */}
          <header style={{ marginBottom: 32 }}>
            <span className="text-[12px] font-semibold uppercase tracking-[1.5px] text-[#ed4e01]">
              {model.vendor} · Built-in model
            </span>
            <h1 className="mt-2 text-[32px] font-semibold leading-[1.15] tracking-tight sm:text-[40px]">
              {model.pageTitle}
            </h1>
            <p className="mt-5 text-[17px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
              {model.tagline}
            </p>

            {/* Quick badges */}
            <div className="mt-6 flex flex-wrap gap-2">
              <Badge value={`×${model.multiplier} credits`} tone="accent" />
              <Badge
                label="Context"
                value={formatContextWindow(model.contextWindowK)}
              />
              <Badge label="Modalities" value={model.modalities.join(" · ")} />
              <Badge
                label="Region"
                value={model.chinaAccessible ? "China-accessible" : "Global"}
              />
              {model.promptCaching && (
                <Badge label="Cache" value="Supported" />
              )}
            </div>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a
                href={platformUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-xl bg-[#ed4e01] px-5 py-2.5 text-[14px] font-semibold text-white shadow-sm transition-colors hover:bg-[#d64601]"
              >
                Use {model.name} on VM0
              </a>
              <Link
                href="/models"
                className="inline-flex items-center gap-2 rounded-xl border border-[hsl(var(--gray-300))] px-5 py-2.5 text-[14px] font-medium text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--gray-50))]"
              >
                Compare all models
              </Link>
            </div>
          </header>

          {/* TL;DR */}
          <div
            className="overflow-hidden rounded-[20px] bg-white p-7 sm:p-8"
            style={{ marginBottom: 48 }}
          >
            <span className="text-[12px] font-semibold uppercase tracking-[1.5px] text-[#ed4e01]">
              TL;DR
            </span>
            <ul className="mt-3 flex flex-col gap-2.5">
              {model.summaryPoints.map((point) => {
                return (
                  <li
                    key={point}
                    className="flex items-start gap-3 text-[16px] font-light leading-relaxed text-[hsl(var(--foreground))]"
                  >
                    <span
                      className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#ed4e01]"
                      aria-hidden="true"
                    />
                    <span>{point}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Overview */}
          <Section title={`Overview: what is ${model.name}?`}>
            <div className="mb-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-[14px] border border-[hsl(var(--gray-200))] bg-white p-4">
                <div className="text-[12px] font-medium uppercase tracking-[1.2px] text-[hsl(var(--muted-foreground))]">
                  Release
                </div>
                <div className="mt-1 text-[15px] text-[hsl(var(--foreground))]">
                  {model.releaseDate}
                </div>
              </div>
              <div className="rounded-[14px] border border-[hsl(var(--gray-200))] bg-white p-4">
                <div className="text-[12px] font-medium uppercase tracking-[1.2px] text-[hsl(var(--muted-foreground))]">
                  Family position
                </div>
                <div className="mt-1 text-[15px] text-[hsl(var(--foreground))]">
                  {model.familyPosition}
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-4">
              {model.background.map((para, i) => {
                return (
                  <p
                    key={i}
                    className="text-[16px] font-light leading-relaxed text-[hsl(var(--foreground))]"
                  >
                    {para}
                  </p>
                );
              })}
            </div>
          </Section>

          {/* What's new / Architecture */}
          {model.architecture.length > 0 && (
            <Section
              title={`What's notable about ${model.name}`}
              subtitle="Headline architecture and capability features."
            >
              <ul className="flex flex-col gap-2">
                {model.architecture.map((item) => {
                  return (
                    <li
                      key={item}
                      className="flex items-start gap-3 text-[16px] font-light leading-relaxed text-[hsl(var(--foreground))]"
                    >
                      <span
                        className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#ed4e01]"
                        aria-hidden="true"
                      />
                      <span>{item}</span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          {/* Specs */}
          <Section title="Specs at a glance">
            <div className="overflow-hidden rounded-[20px] bg-white p-6 sm:px-7">
              {model.specs.map((row, i) => {
                return (
                  <FactRow
                    key={row.label}
                    label={row.label}
                    value={row.value}
                    last={i === model.specs.length - 1}
                  />
                );
              })}
            </div>
          </Section>

          {/* Benchmarks */}
          {model.benchmarks.length > 0 && (
            <Section
              title={`${model.name} benchmarks`}
              subtitle={model.benchmarksNote}
            >
              <div className="overflow-hidden rounded-[16px] border border-[hsl(var(--gray-200))] bg-white">
                {model.benchmarks.map((b, i) => {
                  const last = i === model.benchmarks.length - 1;
                  return (
                    <div
                      key={b.name}
                      className={`flex items-center justify-between gap-4 px-5 py-3 text-[15px]${last ? "" : " border-b border-[hsl(var(--gray-200))]"}`}
                    >
                      <div className="flex flex-col">
                        <span className="text-[hsl(var(--foreground))]">
                          {b.name}
                        </span>
                        {b.note && (
                          <span className="mt-0.5 text-[12px] text-[hsl(var(--muted-foreground))]">
                            {b.note}
                          </span>
                        )}
                      </div>
                      <span className="font-medium text-[hsl(var(--foreground))]">
                        {b.score}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Pricing */}
          <Section
            title={`${model.name} pricing`}
            subtitle={`Provider list price, per 1M tokens. VM0 Managed converts these into credits via the model's ×${model.multiplier} multiplier.`}
          >
            <div className="overflow-hidden rounded-[16px] border border-[hsl(var(--gray-200))] bg-white">
              <PriceRow label="Input" value={formatUsd(model.pricing.inputUsd)} />
              <PriceRow
                label="Output"
                value={formatUsd(model.pricing.outputUsd)}
              />
              <PriceRow
                label="Cache read"
                value={formatUsd(model.pricing.cacheReadUsd)}
              />
              <PriceRow
                label="Cache write"
                value={
                  model.pricing.cacheWriteUsd === null
                    ? "Not billed"
                    : formatUsd(model.pricing.cacheWriteUsd)
                }
                last
              />
            </div>
            <p className="mt-4 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
              <span className="font-medium text-[hsl(var(--foreground))]">
                VM0 cost example.
              </span>{" "}
              {model.vm0CostExample}
            </p>
          </Section>

          {/* Performance */}
          <Section
            title={`Performance: how ${model.name} behaves`}
            subtitle="Notes from VM0's internal evaluation and from observed production behaviour."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {model.performance.map((note) => {
                return (
                  <div
                    key={note.title}
                    className="rounded-[16px] bg-white p-5"
                  >
                    <h3 className="text-[15px] font-medium text-[hsl(var(--foreground))]">
                      {note.title}
                    </h3>
                    <p className="mt-2 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
                      {note.body}
                    </p>
                  </div>
                );
              })}
            </div>
          </Section>

          {/* How VM0 runs it */}
          <Section title={`How VM0 runs ${model.name}`}>
            <p
              className="text-[16px] font-light leading-relaxed text-[hsl(var(--foreground))]"
              style={{ marginBottom: 16 }}
            >
              {model.routingNotes}
            </p>
            {model.vm0Notes.length > 0 && (
              <ul className="flex flex-col gap-2">
                {model.vm0Notes.map((note) => {
                  return (
                    <li
                      key={note}
                      className="flex items-start gap-3 text-[16px] font-light leading-relaxed text-[hsl(var(--foreground))]"
                    >
                      <span
                        className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#ed4e01]"
                        aria-hidden="true"
                      />
                      <span>{note}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {/* Best agent tasks */}
          <Section title={`Best agent tasks for ${model.name} on VM0`}>
            <div className="flex flex-col gap-3">
              {model.bestForExamples.map((ex) => {
                return (
                  <div
                    key={ex.title}
                    className="rounded-[16px] bg-white p-5 sm:p-6"
                  >
                    <h3 className="text-[16px] font-medium text-[hsl(var(--foreground))]">
                      {ex.title}
                    </h3>
                    <p className="mt-2 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
                      {ex.body}
                    </p>
                  </div>
                );
              })}
            </div>
          </Section>

          {/* Skip when */}
          {model.avoidFor.length > 0 && (
            <Section title={`When to skip ${model.name}`}>
              <ul className="flex flex-col gap-2">
                {model.avoidFor.map((tip) => {
                  return (
                    <li
                      key={tip}
                      className="flex items-start gap-3 text-[16px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]"
                    >
                      <span
                        className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--gray-300))]"
                        aria-hidden="true"
                      />
                      <span>{tip}</span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          {/* Comparisons */}
          {model.comparisons.length > 0 && (
            <Section title={`${model.name} vs other models`}>
              <div className="flex flex-col gap-4">
                {model.comparisons.map((cmp) => {
                  return (
                    <div
                      key={cmp.vs}
                      className="rounded-[16px] border border-[hsl(var(--gray-200))] bg-white p-5 sm:p-6"
                    >
                      <h3 className="text-[15px] font-medium text-[hsl(var(--foreground))]">
                        {model.name} vs {cmp.vs}
                      </h3>
                      <p className="mt-2 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
                        {cmp.body}
                      </p>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Verdict / bottom line */}
          {model.verdict && (
            <Section title={`Bottom line: should you use ${model.name}?`}>
              <div className="rounded-[16px] border-l-4 border-[#ed4e01] bg-white p-6 sm:p-7">
                <p className="text-[16px] font-light leading-relaxed text-[hsl(var(--foreground))]">
                  {model.verdict}
                </p>
              </div>
            </Section>
          )}

          {/* FAQ */}
          {model.faqs.length > 0 && (
            <Section title="Frequently asked questions">
              <div className="flex flex-col gap-5">
                {model.faqs.map((faq) => {
                  return (
                    <div key={faq.q}>
                      <h3 className="text-[16px] font-medium text-[hsl(var(--foreground))]">
                        {faq.q}
                      </h3>
                      <p className="mt-2 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
                        {faq.a}
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
                      className="block rounded-[14px] border border-[hsl(var(--gray-200))] bg-white p-5 transition-all hover:-translate-y-0.5 hover:border-[hsl(var(--gray-300))]"
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
                    <div className="uc-related-card-title">
                      {m.name}{" "}
                      <span className="text-[hsl(var(--muted-foreground))]">
                        ×{m.multiplier}
                      </span>
                    </div>
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
