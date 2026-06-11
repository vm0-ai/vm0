"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Footer } from "../../components/Footer";
import {
  ILLUSTRATION_ASSET_BASE,
  ILLUSTRATION_STYLES,
  type IllustrationStyle,
} from "@vm0/core";
import {
  ILLUSTRATION_AUDIENCES,
  ILLUSTRATION_COMPARISON,
  ILLUSTRATION_FAQ,
  ILLUSTRATION_FEATURES,
  SIGNUP_HREF,
} from "./content";

interface LightboxState {
  style: IllustrationStyle;
  activeRef: string;
}

export function IllustrationGalleryClient() {
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  const openLightbox = useCallback((style: IllustrationStyle, ref?: string) => {
    const activeRef = ref && style.refs.includes(ref) ? ref : style.sample;
    setLightbox({ style, activeRef });
  }, []);

  const closeLightbox = useCallback(() => {
    setLightbox(null);
  }, []);

  useEffect(() => {
    if (!lightbox) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeLightbox();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [lightbox, closeLightbox]);

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <HeroSection />
      <FeaturesSection />
      <ComparisonSection />

      <section id="gallery" className="illu-gallery-section">
        <div className="illu-wrap">
          <div className="illu-section-head">
            <p className="illu-eyebrow">The register</p>
            <h2 className="illu-section-title">See what you can make</h2>
            <p className="illu-section-sub">
              Every style in the register, with all of its variations. Click any
              plate to open it.
            </p>
          </div>
          <div className="illu-masonry">
            {ILLUSTRATION_STYLES.map((style) => {
              return (
                <IllustrationCard
                  key={style.slug}
                  style={style}
                  onOpen={openLightbox}
                />
              );
            })}
          </div>
        </div>
      </section>

      <AudienceSection />
      <FaqSection />
      <FinalCtaSection />

      <Footer />

      {lightbox && (
        <Lightbox
          state={lightbox}
          onClose={closeLightbox}
          onSelectRef={(ref) => {
            return setLightbox({ style: lightbox.style, activeRef: ref });
          }}
        />
      )}
    </div>
  );
}

function HeroSection() {
  return (
    <section className="hero-section illu-hero">
      <div className="container">
        <p className="illu-eyebrow">Illustration · powered by Zero</p>
        <h1 className="hero-title illu-hero-title">
          On-brand illustration in a house style that <em>stays consistent</em>
        </h1>
        <p className="hero-description illu-hero-desc">
          Hand Zero a brief and a style. It researches the subject, generates
          editorial illustration in one of {ILLUSTRATION_STYLES.length}+ locked
          styles from the vm0-skills register, and keeps every piece in a series
          on the same palette, line, and cast — not one-off prompt roulette.
        </p>
        <div className="illu-hero-actions">
          <a className="illu-btn illu-btn-primary" href={SIGNUP_HREF}>
            Try a style in Zero
          </a>
          <a className="illu-btn illu-btn-secondary" href="#gallery">
            Browse the gallery
          </a>
        </div>
        <dl className="illu-meta-grid">
          <div>
            <dt>Styles</dt>
            <dd>{ILLUSTRATION_STYLES.length} in the register</dd>
          </div>
          <div>
            <dt>Source register</dt>
            <dd>
              <a
                href="https://github.com/vm0-ai/vm0-skills/pulls?q=is%3Apr+illustration-template"
                target="_blank"
                rel="noopener noreferrer"
              >
                vm0-skills #201 – #236
              </a>
            </dd>
          </div>
          <div>
            <dt>Rendered with</dt>
            <dd>gpt-image-2 · seedream 5 · nano-banana-2</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function FeaturesSection() {
  return (
    <section className="illu-section illu-features">
      <div className="container">
        <div className="illu-section-head">
          <p className="illu-eyebrow">What you get</p>
          <h2 className="illu-section-title">
            A style system, not a slot machine
          </h2>
        </div>
        <div className="illu-feature-grid">
          {ILLUSTRATION_FEATURES.map((feature) => {
            return (
              <article key={feature.title} className="illu-feature-card">
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ComparisonSection() {
  return (
    <section className="illu-section illu-compare">
      <div className="container">
        <div className="illu-section-head">
          <p className="illu-eyebrow">Why it's different</p>
          <h2 className="illu-section-title">
            How this compares to a raw image generator
          </h2>
        </div>
        <div className="illu-compare-table" role="table">
          <div className="illu-compare-row illu-compare-head" role="row">
            <span role="columnheader" />
            <span role="columnheader">Generic AI image tool</span>
            <span role="columnheader" className="illu-compare-zero-col">
              Zero illustration styles
            </span>
          </div>
          {ILLUSTRATION_COMPARISON.map((row) => {
            return (
              <div key={row.aspect} className="illu-compare-row" role="row">
                <span className="illu-compare-aspect" role="rowheader">
                  {row.aspect}
                </span>
                <span className="illu-compare-generic" role="cell">
                  {row.generic}
                </span>
                <span
                  className="illu-compare-cell illu-compare-zero-col"
                  role="cell"
                >
                  {row.zero}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function AudienceSection() {
  return (
    <section className="illu-section illu-audience">
      <div className="container">
        <div className="illu-section-head">
          <p className="illu-eyebrow">Who it's for</p>
          <h2 className="illu-section-title">
            For anyone who needs a consistent look
          </h2>
        </div>
        <div className="illu-audience-grid">
          {ILLUSTRATION_AUDIENCES.map((audience) => {
            return (
              <article key={audience.title} className="illu-audience-card">
                <h3>{audience.title}</h3>
                <p>{audience.body}</p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FaqSection() {
  return (
    <section className="illu-section illu-faq">
      <div className="container">
        <div className="illu-section-head">
          <p className="illu-eyebrow">Good to know</p>
          <h2 className="illu-section-title">Frequently asked questions</h2>
        </div>
        <div className="illu-faq-list">
          {ILLUSTRATION_FAQ.map((item) => {
            return (
              <details key={item.q} className="illu-faq-item">
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FinalCtaSection() {
  return (
    <section className="illu-section illu-final-cta">
      <div className="container">
        <h2 className="illu-final-cta-title">
          Turn a brief into on-brand illustration
        </h2>
        <p className="illu-final-cta-sub">
          Pick a style, hand Zero the idea, and get illustration that matches
          the rest of your brand.
        </p>
        <a className="illu-btn illu-btn-primary" href={SIGNUP_HREF}>
          Start in Zero
        </a>
      </div>
    </section>
  );
}

interface CardProps {
  style: IllustrationStyle;
  onOpen: (style: IllustrationStyle, ref?: string) => void;
}

function IllustrationCard({ style, onOpen }: CardProps) {
  const coverSrc = style.cover
    ? `${ILLUSTRATION_ASSET_BASE}/${style.cover}`
    : `${ILLUSTRATION_ASSET_BASE}/images/${style.image}`;

  return (
    <article className="illu-tile">
      <button
        type="button"
        className="illu-tile-plate"
        aria-label={`Open ${style.title}`}
        onClick={() => {
          return onOpen(style);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={coverSrc}
          width={style.width}
          height={style.height}
          alt={style.title}
          loading="lazy"
        />
      </button>

      <div className="illu-tile-caption">
        <h3>{style.title}</h3>
        <span className="illu-tile-count">
          <em>{style.refs.length} variations</em>
        </span>
      </div>

      <div className="illu-refs-strip">
        {style.refs.map((ref) => {
          const isSample = ref === style.sample;
          return (
            <button
              key={ref}
              type="button"
              className={
                isSample ? "illu-ref-thumb is-sample" : "illu-ref-thumb"
              }
              aria-label={`${style.title} variation ${ref}`}
              onClick={() => {
                return onOpen(style, ref);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${ILLUSTRATION_ASSET_BASE}/refs/${style.slug}/${ref}`}
                loading="lazy"
                alt=""
              />
            </button>
          );
        })}
      </div>
    </article>
  );
}

interface LightboxProps {
  state: LightboxState;
  onClose: () => void;
  onSelectRef: (ref: string) => void;
}

function Lightbox({ state, onClose, onSelectRef }: LightboxProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const { style, activeRef } = state;
  const refCount = style.refs.length;
  const activeSrc = `${ILLUSTRATION_ASSET_BASE}/refs/${style.slug}/${activeRef}`;

  if (!mounted) {
    return null;
  }

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
        <img src={activeSrc} alt={style.title} />
      </div>
      <div className="illu-lb-strip">
        {style.refs.map((ref) => {
          const classes = ["illu-lb-thumb"];
          if (ref === style.sample) {
            classes.push("is-sample");
          }
          if (ref === activeRef) {
            classes.push("active");
          }
          return (
            <button
              key={ref}
              type="button"
              className={classes.join(" ")}
              aria-label={ref}
              onClick={(e) => {
                e.stopPropagation();
                onSelectRef(ref);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${ILLUSTRATION_ASSET_BASE}/refs/${style.slug}/${ref}`}
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
