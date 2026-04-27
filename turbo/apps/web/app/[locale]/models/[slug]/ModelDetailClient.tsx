"use client";

import { Link } from "../../../../navigation";
import { Footer } from "../../../components/Footer";
import { Particles } from "../../../components/Particles";
import { getAppUrl } from "../../../../src/lib/zero/url";
import type { ModelEntry } from "../data";

const MAX_WIDTH = 880;
const PAGE_PADDING = 24;

function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(3)}`;
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

function FactRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[hsl(var(--gray-200))/0.7] py-3 last:border-b-0">
      <span className="text-[13px] font-medium uppercase tracking-[1.2px] text-[hsl(var(--muted-foreground))]">
        {label}
      </span>
      <span className="text-[15px] text-[hsl(var(--foreground))]">{value}</span>
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
    <section className="uc-section">
      <h2 className="uc-section-title" style={{ marginBottom: 16 }}>
        {title}
      </h2>
      {children}
    </section>
  );
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

          {/* Header */}
          <header style={{ marginBottom: 40 }}>
            <span className="text-[12px] font-semibold uppercase tracking-[1.5px] text-[#ed4e01]">
              {model.vendor} · Built-in model
            </span>
            <h1 className="mt-2 text-[32px] font-semibold leading-[1.15] tracking-tight sm:text-[40px]">
              {model.detailHeading}
            </h1>
            <p className="mt-5 text-[16px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
              {model.intro}
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
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

          {/* At a glance */}
          <div className="overflow-hidden rounded-[20px] bg-white p-7 sm:p-8">
            <h2 className="text-[18px] font-medium tracking-[-0.2px] text-[hsl(var(--foreground))]">
              At a glance
            </h2>
            <div className="mt-2">
              <FactRow label="Model id" value={<code>{model.modelId}</code>} />
              <FactRow label="Vendor" value={model.vendor} />
              <FactRow
                label="Credit multiplier"
                value={`×${model.multiplier} (Sonnet 4.6 = ×1)`}
              />
              {model.contextWindowK !== undefined && (
                <FactRow
                  label="Context window"
                  value={
                    model.contextWindowK >= 1000
                      ? `${(model.contextWindowK / 1000).toFixed(0)}M tokens`
                      : `${model.contextWindowK}K tokens`
                  }
                />
              )}
              <FactRow
                label="Prompt caching"
                value={model.promptCaching ? "Supported" : "Not supported"}
              />
              {model.vm0TimeoutMin !== undefined && (
                <FactRow
                  label="VM0 API timeout"
                  value={`${model.vm0TimeoutMin} minutes`}
                />
              )}
              {model.defaultFor.length > 0 && (
                <FactRow
                  label="Default for"
                  value={model.defaultFor.join(", ")}
                />
              )}
              <FactRow label="Available on VM0" value={model.releasedToVm0} />
            </div>
          </div>

          {/* Pricing */}
          <Section title="Pricing">
            <p
              className="uc-section-body"
              style={{ marginTop: -8, marginBottom: 16 }}
            >
              Provider list price, per 1M tokens. VM0 Managed converts these
              into credits via the model&rsquo;s ×{model.multiplier} multiplier.
            </p>
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
          </Section>

          {/* How VM0 runs it */}
          <Section title={`How VM0 runs ${model.name}`}>
            <p className="uc-section-body" style={{ marginBottom: 16 }}>
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

          {/* Best for */}
          <Section title={`What ${model.name} is best for`}>
            <ul className="flex flex-col gap-2">
              {model.bestFor.map((tip) => {
                return (
                  <li
                    key={tip}
                    className="flex items-start gap-3 text-[16px] font-light leading-relaxed text-[hsl(var(--foreground))]"
                  >
                    <span
                      className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#ed4e01]"
                      aria-hidden="true"
                    />
                    <span>{tip}</span>
                  </li>
                );
              })}
            </ul>
          </Section>

          {/* Skip when */}
          {model.avoidFor.length > 0 && (
            <Section title="Skip when">
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
                    <div className="uc-related-card-desc">{m.intro}</div>
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
      className={`flex items-center justify-between px-5 py-3 text-[15px]${last ? "" : " border-b border-[hsl(var(--gray-200))/0.7]"}`}
    >
      <span className="text-[hsl(var(--muted-foreground))]">{label}</span>
      <span className="font-medium text-[hsl(var(--foreground))]">
        {value} <span className="text-[13px] font-normal text-[hsl(var(--muted-foreground))]">/ 1M tokens</span>
      </span>
    </div>
  );
}

function altName(slug: string): string {
  // Convert slug back to a friendly name without re-importing MODELS to avoid
  // a circular dep through the related list. We keep this in sync with data.ts.
  const map: Record<string, string> = {
    "claude-opus-4-7": "Claude Opus 4.7",
    "claude-opus-4-6": "Claude Opus 4.6",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "glm-5.1": "GLM-5.1",
    "kimi-k2.6": "Kimi K2.6",
    "kimi-k2.5": "Kimi K2.5",
    "minimax-m2.7": "MiniMax M2.7",
    "deepseek-v4-pro": "DeepSeek V4 Pro",
    "deepseek-v4-flash": "DeepSeek V4 Flash",
  };
  return map[slug] ?? slug;
}
