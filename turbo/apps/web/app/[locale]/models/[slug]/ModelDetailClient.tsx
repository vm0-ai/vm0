"use client";

import { IconArrowRight } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
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

function getMultiplierKey(m: number): string {
  if (m === 1) return "multiplierPositioningBaseline";
  if (m > 1) return "multiplierPositioningPremium";
  if (m <= 0.05) return "multiplierPositioningCheapest";
  return "multiplierPositioningBelowBaseline";
}

interface Props {
  model: ModelEntry;
  related: ModelEntry[];
}

export function ModelDetailClient({ model, related }: Props) {
  const t = useTranslations("models");
  const platformUrl = getAppUrl();
  const c = (key: string) => {
    return `content.${model.slug}.${key}`;
  };
  const rc = (slug: string, key: string) => {
    return `content.${slug}.${key}`;
  };

  const heroMeta = [
    formatContextWindow(model.contextWindowK),
    model.modalities.join(" / "),
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
            &larr; {t("backToAllModels")}
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
              {t(c("pageTitle"))}
            </h1>
            <p className="mt-5 text-[17px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
              {t(c("tagline"))}
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
                <span>{t("useModelButton", { name: model.name })}</span>
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
              {t(c("summary"))
                .split("\n\n")
                .map((para, i) => {
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
          <Section title={t("whatIsHeading", { name: model.name })}>
            <p className="mb-6 text-[14px] text-[hsl(var(--muted-foreground))]">
              {t(c("releaseDate"))} · {t(c("familyPosition"))}
            </p>
            <div className="flex flex-col gap-4">
              {(t.raw(c("background")) as string[]).map((para, i) => {
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
          {t(c("architecture")) && (
            <Section
              title={t("whatsNotableHeading", { name: model.name })}
              subtitle={t("whatsNotableSubtitle")}
            >
              <p className="text-[16px] leading-relaxed text-[hsl(var(--foreground))]">
                {inlineCode(t(c("architecture")))}
              </p>
            </Section>
          )}

          {/* Specs */}
          <Section title={t("specsHeading")}>
            <Card>
              {(t.raw(c("specs")) as { label: string; value: string }[]).map(
                (row, i, arr) => {
                  return (
                    <DataRow
                      key={row.label}
                      label={row.label}
                      value={row.value}
                      last={i === arr.length - 1}
                    />
                  );
                },
              )}
            </Card>
          </Section>

          {/* Benchmarks */}
          {(
            t.raw(c("benchmarks")) as {
              name: string;
              score: string;
              note?: string;
            }[]
          ).length > 0 && (
            <Section
              title={t("benchmarksHeading", { name: model.name })}
              subtitle={t(c("benchmarksNote"))}
            >
              <Card>
                {(
                  t.raw(c("benchmarks")) as {
                    name: string;
                    score: string;
                    note?: string;
                  }[]
                ).map((b, i, arr) => {
                  const last = i === arr.length - 1;
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
            title={t("pricingHeading", { name: model.name })}
            subtitle={t("pricingSubtitle")}
          >
            <Card>
              <DataRow
                label={t("labelInput")}
                value={formatUsd(model.pricing.inputUsd)}
              />
              <DataRow
                label={t("labelOutput")}
                value={formatUsd(model.pricing.outputUsd)}
              />
              <DataRow
                label={t("labelCacheRead")}
                value={formatUsd(model.pricing.cacheReadUsd)}
              />
              <DataRow
                label={t("labelCacheWrite")}
                value={
                  model.pricing.cacheWriteUsd === null
                    ? t("labelNotBilled")
                    : formatUsd(model.pricing.cacheWriteUsd)
                }
                last
              />
            </Card>
          </Section>

          {/* Performance */}
          <Section
            title={t("performanceHeading", { name: model.name })}
            subtitle={t("performanceSubtitle")}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                t.raw(c("performance")) as { title: string; body: string }[]
              ).map((note) => {
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
          <Section title={t("bestForHeading", { name: model.name })}>
            <div className="flex flex-col gap-4">
              {(
                t.raw(c("bestForExamples")) as { title: string; body: string }[]
              ).map((ex) => {
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
          {t(c("avoidFor")) && (
            <Section title={t("skipWhenHeading", { name: model.name })}>
              <p className="text-[16px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                {inlineCode(t(c("avoidFor")))}
              </p>
            </Section>
          )}

          {/* Comparisons */}
          {model.comparisonSlugs.length > 0 && (
            <Section title={t("comparisonsHeading", { name: model.name })}>
              <div className="flex flex-col gap-4">
                {(() => {
                  const cmps = t.raw(c("comparisons")) as {
                    vs: string;
                    body: string;
                  }[];
                  return cmps.map((cmp) => {
                    return (
                      <Card key={cmp.vs} className="!p-6">
                        <h3 className="text-[18px] font-medium text-[hsl(var(--foreground))]">
                          {t("comparisonTitleTemplate", {
                            model: model.name,
                            other: cmp.vs,
                          })}
                        </h3>
                        <p className="mt-2 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
                          {inlineCode(cmp.body)}
                        </p>
                      </Card>
                    );
                  });
                })()}
              </div>
            </Section>
          )}

          {/* Verdict */}
          {t(c("verdict")) && (
            <Section title={t("verdictHeading", { name: model.name })}>
              <div className="rounded-2xl border-l-[3px] border-[#ed4e01] bg-white p-6 sm:p-8">
                <p className="text-[16px] leading-relaxed text-[hsl(var(--foreground))]">
                  {inlineCode(t(c("verdict")))}
                </p>
              </div>
            </Section>
          )}

          {/* FAQ */}
          {(t.raw(c("faqs")) as { q: string; a: string }[]).length > 0 && (
            <Section title={t("faqHeading")}>
              <div className="flex flex-col gap-7">
                {(t.raw(c("faqs")) as { q: string; a: string }[]).map((faq) => {
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
          {model.alternativeSlugs.length > 0 && (
            <Section title={t("alternativesHeading")}>
              <div className="grid gap-3 sm:grid-cols-2">
                {(() => {
                  const alts = t.raw(c("alternatives")) as {
                    slug: string;
                    reason: string;
                  }[];
                  return alts.map((alt) => {
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
                  });
                })()}
              </div>
            </Section>
          )}

          {/* Using on VM0 */}
          <Section title={t("usingOnVm0Heading", { name: model.name })}>
            <div className="flex flex-col gap-5">
              <div>
                <h3 className="text-[18px] font-medium text-[hsl(var(--foreground))]">
                  {t("twoWaysToAccessHeading", { name: model.name })}
                </h3>
                <p className="mt-2 text-[16px] leading-relaxed text-[hsl(var(--foreground))]">
                  {t("twoWaysToAccessBody", {
                    name: model.name,
                    byoKey: model.byoKeyLabel,
                  })}
                </p>
              </div>

              <div>
                <h3 className="text-[18px] font-medium text-[hsl(var(--foreground))]">
                  {t("vm0RecommendationHeading")}
                </h3>
                <p className="mt-2 text-[16px] leading-relaxed text-[hsl(var(--foreground))]">
                  {t(
                    model.vm0Tier === "core"
                      ? "tierExplanationCore"
                      : "tierExplanationCostSaving",
                    { name: model.name },
                  )}
                </p>
              </div>

              <div>
                <h3 className="text-[18px] font-medium text-[hsl(var(--foreground))]">
                  {t("creditsMultiplierHeading", {
                    multiplier: model.multiplier,
                  })}
                </h3>
                <p className="mt-2 text-[16px] leading-relaxed text-[hsl(var(--foreground))]">
                  {t("creditsMultiplierBodyP1", {
                    name: model.name,
                    multiplier: model.multiplier,
                  })}
                </p>
                <p className="mt-3 text-[16px] leading-relaxed text-[hsl(var(--foreground))]">
                  {t(getMultiplierKey(model.multiplier), {
                    name: model.name,
                    multiplier: model.multiplier,
                  })}
                </p>
              </div>

              <p className="text-[14px] text-[hsl(var(--muted-foreground))]">
                {t("availableSince", { date: model.releasedToVm0 })}
              </p>
            </div>
          </Section>

          {/* Related */}
          <div className="uc-related">
            <h2 className="uc-related-title">{t("moreModelsHeading")}</h2>
            <div className="uc-related-grid">
              {related.map((m) => {
                return (
                  <Link
                    key={m.slug}
                    href={`/models/${m.slug}`}
                    className="uc-related-card"
                  >
                    <div className="uc-related-card-title">
                      {t(rc(m.slug, "name"))}
                    </div>
                    <div className="uc-related-card-desc">
                      {t(rc(m.slug, "cardIntro"))}
                    </div>
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
