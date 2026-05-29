"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { Fraunces } from "next/font/google";
import { IconArrowUpRight } from "@tabler/icons-react";
import { Link } from "../../../../navigation";
import { Footer } from "../../../components/Footer";
import { getAppUrl } from "../../../../src/lib/zero/url";
import {
  type IllustrationStyle,
  getIllustrationBySlug,
  hasDetailPage,
} from "../data";

const ASSET_BASE = "https://quiet-moments-gallery-715f6d07.sites.vm0.io";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["italic"],
  variable: "--font-fraunces",
  display: "swap",
  preload: false,
});

interface LightboxState {
  activeRef: string;
}

export function IllustrationDetailClient({
  style,
}: {
  style: IllustrationStyle;
}) {
  const t = useTranslations("illustration");
  const slug = style.slug;
  const appUrl = getAppUrl();

  const seoTitle = t(`content.${slug}.seoTitle`);
  const lede = t(`content.${slug}.lede`);
  const definition = t(`content.${slug}.definition`);
  const ctaBody = t(`content.${slug}.ctaBody`);
  const valueProps = t.raw(`content.${slug}.valueProps`) as {
    title: string;
    body: string;
  }[];
  const anatomy = t.raw(`content.${slug}.anatomy`) as {
    label: string;
    body: string;
  }[];
  const whenToUse = t.raw(`content.${slug}.whenToUse`) as {
    persona: string;
    body: string;
  }[];
  const recipe = t.raw(`content.${slug}.recipe`) as {
    prompt: string;
    note: string;
  };
  const comparison = t.raw(`content.${slug}.comparison`) as {
    versus: string;
    body: string;
  }[];
  const variationCaptions = t.raw(`content.${slug}.variationCaptions`) as Record<
    string,
    string
  >;
  const faq = t.raw(`content.${slug}.faq`) as {
    question: string;
    answer: string;
  }[];

  const relatedStyles = (style.relatedSlugs ?? [])
    .map((s) => {
      return getIllustrationBySlug(s);
    })
    .filter((s): s is IllustrationStyle => {
      return Boolean(s);
    });

  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const openLightbox = useCallback((ref: string) => {
    setLightbox({ activeRef: ref });
  }, []);
  const closeLightbox = useCallback(() => {
    setLightbox(null);
  }, []);

  useEffect(() => {
    if (!lightbox) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [lightbox, closeLightbox]);

  const heroSrc = `${ASSET_BASE}/refs/${slug}/${style.sample}`;

  return (
    <div
      className={`landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))] ${fraunces.variable}`}
    >
      <main className="illu-detail-main">
        <article className="illu-detail-article">
          {/* Breadcrumb */}
          <nav className="illu-detail-breadcrumb" aria-label="Breadcrumb">
            <Link href="/">{t("breadcrumbHome")}</Link>
            <span aria-hidden="true">›</span>
            <Link href="/illustration">{t("breadcrumbIllustration")}</Link>
            <span aria-hidden="true">›</span>
            <span aria-current="page">{style.title}</span>
          </nav>

          {/* Hero — single column, copy first then plate */}
          <header className="illu-detail-hero">
            <h1 className="illu-detail-h1">{seoTitle}</h1>
            <p className="illu-detail-lede">{lede}</p>

            <dl className="illu-detail-meta">
              <div>
                <dt>{t("metaVariations")}</dt>
                <dd>{t("variationCount", { count: style.refs.length })}</dd>
              </div>
              {style.model && (
                <div>
                  <dt>{t("metaModel")}</dt>
                  <dd>{style.model}</dd>
                </div>
              )}
              {style.palette && (
                <div>
                  <dt>{t("metaPalette")}</dt>
                  <dd>{style.palette}</dd>
                </div>
              )}
              {style.registerPR && (
                <div>
                  <dt>{t("metaRegister")}</dt>
                  <dd>
                    <a
                      href="https://github.com/vm0-ai/vm0-skills/pulls"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {style.registerPR}
                    </a>
                  </dd>
                </div>
              )}
            </dl>

            <div className="illu-detail-hero-ctas">
              <a
                href={appUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="illu-detail-cta-primary"
              >
                {t("primaryCta")}
                <IconArrowUpRight size={16} />
              </a>
              <Link
                href="/illustration"
                className="illu-detail-cta-secondary"
              >
                {t("secondaryCta")}
              </Link>
            </div>

            <button
              type="button"
              className="illu-detail-hero-plate"
              onClick={() => {
                return openLightbox(style.sample);
              }}
              aria-label={t("openLightbox")}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={heroSrc}
                width={style.width}
                height={style.height}
                alt={`${style.title} — ${variationCaptions[style.sample] ?? style.title}`}
              />
            </button>
          </header>

          {/* Definition — Google snippet target */}
          <section className="illu-detail-section">
            <h2 className="illu-detail-h2">
              {t("definitionHeading", { title: style.title })}
            </h2>
            <p className="illu-detail-body illu-detail-definition">
              {definition}
            </p>
          </section>

          {/* Value props — marketing punch */}
          <section className="illu-detail-section">
            <h2 className="illu-detail-h2">
              {t("summaryHeading", { title: style.title })}
            </h2>
            <div className="illu-detail-valueprops">
              {valueProps.map((vp) => {
                return (
                  <div key={vp.title} className="illu-detail-valueprop">
                    <h3>{vp.title}</h3>
                    <p>{vp.body}</p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Variation gallery — single column stack */}
          <section className="illu-detail-section">
            <h2 className="illu-detail-h2">
              {t("variationsHeading", { count: style.refs.length })}
            </h2>
            <p className="illu-detail-body illu-detail-muted">
              {t("variationsLede")}
            </p>
            <div className="illu-detail-stack">
              {style.refs.map((ref) => {
                const caption = variationCaptions[ref] ?? style.title;
                return (
                  <figure key={ref} className="illu-detail-figure">
                    <button
                      type="button"
                      className="illu-detail-figure-plate"
                      onClick={() => {
                        return openLightbox(ref);
                      }}
                      aria-label={`${style.title} — ${caption}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`${ASSET_BASE}/refs/${slug}/${ref}`}
                        loading="lazy"
                        alt={`${style.title} — ${caption}`}
                      />
                    </button>
                    <figcaption>{caption}</figcaption>
                  </figure>
                );
              })}
            </div>
          </section>

          {/* Anatomy — single column stack */}
          <section className="illu-detail-section">
            <h2 className="illu-detail-h2">{t("anatomyHeading")}</h2>
            <div className="illu-detail-rows">
              {anatomy.map((row) => {
                return (
                  <div key={row.label} className="illu-detail-row">
                    <h3>{row.label}</h3>
                    <p>{row.body}</p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* When to use — single column stack */}
          <section className="illu-detail-section">
            <h2 className="illu-detail-h2">
              {t("whenToUseHeading", { title: style.title })}
            </h2>
            <div className="illu-detail-rows">
              {whenToUse.map((row) => {
                return (
                  <div key={row.persona} className="illu-detail-row">
                    <h3>{row.persona}</h3>
                    <p>{row.body}</p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Recipe — slash command + sample prompt + CTA */}
          <section className="illu-detail-section">
            <h2 className="illu-detail-h2">
              {t("recipeHeading", { title: style.title })}
            </h2>
            <p className="illu-detail-body">{t("recipeIntro")}</p>
            {style.slashCommand && (
              <div className="illu-detail-recipe-command">
                <span className="illu-detail-recipe-label">
                  {t("recipeCommandLabel")}
                </span>
                <code>{style.slashCommand}</code>
              </div>
            )}
            <div className="illu-detail-recipe-prompt">{recipe.prompt}</div>
            <p className="illu-detail-body illu-detail-muted">{recipe.note}</p>
            <div className="illu-detail-recipe-cta">
              <a
                href={appUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="illu-detail-cta-primary"
              >
                {t("primaryCta")}
                <IconArrowUpRight size={16} />
              </a>
            </div>
          </section>

          {/* Comparison — SEO clustering */}
          <section className="illu-detail-section">
            <h2 className="illu-detail-h2">
              {t("comparisonHeading", { title: style.title })}
            </h2>
            <div className="illu-detail-rows">
              {comparison.map((row) => {
                return (
                  <div key={row.versus} className="illu-detail-row">
                    <h3>{row.versus}</h3>
                    <p>{row.body}</p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Related — horizontal row cards */}
          {relatedStyles.length > 0 && (
            <section className="illu-detail-section">
              <h2 className="illu-detail-h2">{t("relatedHeading")}</h2>
              <div className="illu-detail-related">
                {relatedStyles.map((rel) => {
                  const relCover = rel.cover
                    ? `${ASSET_BASE}/${rel.cover}`
                    : `${ASSET_BASE}/images/${rel.image}`;
                  const href = hasDetailPage(rel)
                    ? `/illustration/${rel.slug}`
                    : "/illustration";
                  return (
                    <Link
                      key={rel.slug}
                      href={href}
                      className="illu-detail-related-card"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={relCover} alt={rel.title} loading="lazy" />
                      <div>
                        <h3>{rel.title}</h3>
                        <span>
                          {t("variationCount", { count: rel.refs.length })}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          {/* FAQ */}
          <section className="illu-detail-section">
            <h2 className="illu-detail-h2">{t("faqHeading")}</h2>
            <div className="illu-detail-faq">
              {faq.map((row) => {
                return (
                  <details key={row.question} className="illu-detail-faq-row">
                    <summary>{row.question}</summary>
                    <p>{row.answer}</p>
                  </details>
                );
              })}
            </div>
          </section>

          {/* Closing CTA */}
          <section className="illu-detail-closing-cta">
            <h2 className="illu-detail-h2">
              {t("ctaSectionHeading", { title: style.title })}
            </h2>
            <p className="illu-detail-body">{ctaBody}</p>
            <div className="illu-detail-hero-ctas">
              <a
                href={appUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="illu-detail-cta-primary"
              >
                {t("primaryCta")}
                <IconArrowUpRight size={16} />
              </a>
              <Link
                href="/illustration"
                className="illu-detail-cta-secondary"
              >
                {t("secondaryCta")}
              </Link>
            </div>
          </section>
        </article>
      </main>

      <Footer />

      {lightbox && (
        <Lightbox
          style={style}
          activeRef={lightbox.activeRef}
          captions={variationCaptions}
          onClose={closeLightbox}
          onSelectRef={(ref) => {
            return setLightbox({ activeRef: ref });
          }}
        />
      )}
    </div>
  );
}

interface LightboxProps {
  style: IllustrationStyle;
  activeRef: string;
  captions: Record<string, string>;
  onClose: () => void;
  onSelectRef: (ref: string) => void;
}

function Lightbox({
  style,
  activeRef,
  captions,
  onClose,
  onSelectRef,
}: LightboxProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const activeSrc = `${ASSET_BASE}/refs/${style.slug}/${activeRef}`;
  const refCount = style.refs.length;

  if (!mounted) return null;

  return createPortal(
    <div className="illu-lightbox" role="dialog" aria-modal="true">
      <div className="illu-lb-header">
        <div>
          <p className="illu-lb-sub">
            {refCount} variation{refCount === 1 ? "" : "s"}
          </p>
          <p className="illu-lb-title">{style.title}</p>
        </div>
        <button
          type="button"
          className="illu-lb-close"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="illu-lb-main" onClick={onClose} role="presentation">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={activeSrc} alt={captions[activeRef] ?? style.title} />
      </div>
      <div className="illu-lb-strip">
        {style.refs.map((ref) => {
          const classes = ["illu-lb-thumb"];
          if (ref === style.sample) classes.push("is-sample");
          if (ref === activeRef) classes.push("active");
          return (
            <button
              key={ref}
              type="button"
              className={classes.join(" ")}
              aria-label={captions[ref] ?? ref}
              onClick={(e) => {
                e.stopPropagation();
                onSelectRef(ref);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${ASSET_BASE}/refs/${style.slug}/${ref}`}
                loading="lazy"
                alt=""
              />
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
