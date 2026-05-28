"use client";

import { useCallback, useEffect, useState } from "react";
import { ILLUSTRATION_STYLES, type IllustrationStyle } from "./data";

const ASSET_BASE = "/illustration";

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
    <div className="illustration-page">
      <style>{`.header-container{display:none}`}</style>

      <div className="illu-wrap">
        <div className="illu-ribbon">
          <span>vm0-skills · the illustration register</span>
          <span className="center">Quiet Moments</span>
          <span className="accent">Issue Nº 02 · Spring 2026</span>
        </div>

        <header className="illu-masthead">
          <div className="left">
            <p className="illu-kicker">
              An editorial gallery — twenty-two styles, one brief.
            </p>
            <h1 className="illu-h1">
              Quiet Moments, <em>by twenty-two hands.</em>
            </h1>
          </div>
          <div className="right">
            <p className="illu-dek">
              One quiet theme — focus, craft, and the small rituals that hold an
              evening together — rendered through every illustration style in
              the register. Click any plate to see every AI variation the style
              can produce.
            </p>
          </div>
          <dl className="illu-meta">
            <div>
              <dt>Pieces</dt>
              <dd>22 styles</dd>
            </div>
            <div>
              <dt>New this issue</dt>
              <dd>3 styles</dd>
            </div>
            <div>
              <dt>Source register</dt>
              <dd>
                <a
                  href="https://github.com/vm0-ai/vm0-skills/pulls?q=is%3Apr+illustration-template"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  vm0-skills #201 – #229
                </a>
              </dd>
            </div>
            <div>
              <dt>Rendered with</dt>
              <dd>gpt-image-2 · seedream 5 · nano-banana-2</dd>
            </div>
          </dl>
        </header>

        <div className="illu-gallery-rule">
          <span className="label">The Gallery</span>
          <span className="count">
            <em>twenty-two plates · click for every AI variation</em>
          </span>
        </div>

        <main className="illu-masonry">
          {ILLUSTRATION_STYLES.map((style) => {
            return (
              <article
                key={style.slug}
                className={style.isNew ? "illu-tile is-new" : "illu-tile"}
              >
                <button
                  type="button"
                  className="illu-tile-main"
                  aria-label={`Open ${style.title}`}
                  onClick={() => {
                    return openLightbox(style);
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`${ASSET_BASE}/images/${style.image}`}
                    width={style.width}
                    height={style.height}
                    alt={style.title}
                    loading="lazy"
                  />
                </button>
                <div className="illu-tile-refs">
                  <span className="illu-tile-refs__caption">
                    {style.refs.length} var
                  </span>
                  {style.refs.map((ref) => {
                    const isSample = ref === style.sample;
                    return (
                      <button
                        key={ref}
                        type="button"
                        className={
                          isSample
                            ? "illu-tile-refs__thumb is-sample"
                            : "illu-tile-refs__thumb"
                        }
                        aria-label={`${style.title} variation ${ref}`}
                        onClick={() => {
                          return openLightbox(style, ref);
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
          })}
        </main>

        <footer className="illu-colophon">
          <div>
            <h4>About this issue</h4>
            <p>
              Quiet Moments is an open gallery exhibiting every styled-template
              skill in the{" "}
              <a
                href="https://github.com/vm0-ai/vm0-skills"
                target="_blank"
                rel="noopener noreferrer"
              >
                vm0-skills
              </a>{" "}
              register. Each plate shows one piece in that style; clicking opens
              every AI variation the skill can produce, so the consistency of
              each style is visible.
            </p>
          </div>
          <div>
            <h4>New plates</h4>
            <p>
              <a
                href="https://github.com/vm0-ai/vm0-skills/pull/227"
                target="_blank"
                rel="noopener noreferrer"
              >
                Light Pop Portrait
              </a>{" "}
              — single-character portraits on a saturated color block, with
              star-sparkle blush and big shiny eyes.
            </p>
            <p>
              <a
                href="https://github.com/vm0-ai/vm0-skills/pull/228"
                target="_blank"
                rel="noopener noreferrer"
              >
                Endpaper
              </a>{" "}
              — scattered children&apos;s-book endpaper collections with
              riso-grain shading and closed-crescent-eye sleepy smiles.
            </p>
            <p>
              <a
                href="https://github.com/vm0-ai/vm0-skills/pull/229"
                target="_blank"
                rel="noopener noreferrer"
              >
                Editorial Flatfolk
              </a>{" "}
              — saturated naive book-illustration scenes with tall narrow
              row-house architecture and ink sun-ray hatching.
            </p>
          </div>
          <div>
            <h4>Colophon</h4>
            <p>
              Type set in Fraunces &amp; Inter. Plates and variations rendered
              via fal.ai endpoints — gpt-image-2, seedream 5, nano-banana-2.
            </p>
            <p className="signoff">— vm0, spring 2026</p>
          </div>
        </footer>
      </div>

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

interface LightboxProps {
  state: LightboxState;
  onClose: () => void;
  onSelectRef: (ref: string) => void;
}

function Lightbox({ state, onClose, onSelectRef }: LightboxProps) {
  const { style, activeRef } = state;
  const refCount = style.refs.length;
  const subLabel = `${refCount} AI variation${refCount === 1 ? "" : "s"}`;
  const activeSrc = `${ASSET_BASE}/refs/${style.slug}/${activeRef}`;

  return (
    <div className="illu-lightbox open" role="dialog" aria-modal="true">
      <div className="illu-lb-header">
        <div>
          <p className="illu-lb-sub">{subLabel}</p>
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
    </div>
  );
}
