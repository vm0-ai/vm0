"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Footer } from "../../components/Footer";
import { ILLUSTRATION_STYLES, type IllustrationStyle } from "./data";

const ASSET_BASE =
  "https://quiet-moments-gallery-715f6d07-715f6d07.sites.vm0.io";

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
      <section className="hero-section illu-hero">
        <div className="container">
          <h1 className="hero-title">Illustration</h1>
          <p className="hero-description">
            An open gallery of every illustration style in the vm0-skills
            register. Click any plate to see every AI variation the style can
            produce.
          </p>
          <dl className="illu-meta-grid">
            <div>
              <dt>Pieces</dt>
              <dd>{ILLUSTRATION_STYLES.length} styles</dd>
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

      <section style={{ paddingBottom: "120px" }}>
        <div className="illu-wrap">
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

interface CardProps {
  style: IllustrationStyle;
  onOpen: (style: IllustrationStyle, ref?: string) => void;
}

function IllustrationCard({ style, onOpen }: CardProps) {
  const coverSrc = style.cover
    ? `${ASSET_BASE}/${style.cover}`
    : `${ASSET_BASE}/images/${style.image}`;

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
                src={`${ASSET_BASE}/refs/${style.slug}/${ref}`}
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
  const activeSrc = `${ASSET_BASE}/refs/${style.slug}/${activeRef}`;

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
