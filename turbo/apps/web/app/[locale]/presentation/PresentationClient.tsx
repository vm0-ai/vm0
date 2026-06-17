"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { IconExternalLink, IconSparkles } from "@tabler/icons-react";
import { r2ImageTransformUrl } from "@vm0/core";
import { CopyablePrompt } from "../../components/CopyablePrompt";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import { getAppUrl } from "../../../src/lib/zero/url";
import {
  PRESENTATION_ITEMS,
  buildPresentationRemixHref,
  type PresentationItem,
} from "./data";
import {
  parsePresentationPreviewDeck,
  pointerIndexForClientX,
  previewPresentationSlideHtml,
  type PresentationPreviewDeck,
} from "./presentationHtmlPreview";

const MAX_WIDTH = 880;
const PAGE_PADDING = 24;
const PRESENTATION_PREVIEW_IMAGE_SIZE = { width: 1664, height: 824 } as const;
const HTML_PREVIEW_MIN_SLIDES = 2;

function PresentationPreview({ item }: { item: PresentationItem }) {
  const fallbackImages = useMemo(() => {
    return item.previewImages.length > 0
      ? item.previewImages
      : [item.previewImage];
  }, [item.previewImage, item.previewImages]);
  const abortRef = useRef<AbortController | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [deck, setDeck] = useState<PresentationPreviewDeck | null>(null);
  const [htmlPreviewFailed, setHtmlPreviewFailed] = useState(false);
  const [loadingHtmlPreview, setLoadingHtmlPreview] = useState(false);
  const [previewFrameUrl, setPreviewFrameUrl] = useState<string | null>(null);
  const activeSlideCount = deck?.slides.length ?? fallbackImages.length;
  const fallbackImage =
    fallbackImages[Math.min(activeIndex, fallbackImages.length - 1)] ??
    item.previewImage;

  const loadHtmlPreview = useCallback(() => {
    if (deck || htmlPreviewFailed || loadingHtmlPreview) {
      return;
    }
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setLoadingHtmlPreview(true);
    void fetch(item.embedUrl, {
      credentials: "omit",
      signal: abort.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `Failed to load presentation HTML (${response.status})`,
          );
        }
        return response.text();
      })
      .then((html) => {
        const parsed = parsePresentationPreviewDeck(html);
        if (parsed.slides.length < HTML_PREVIEW_MIN_SLIDES) {
          throw new Error("Presentation HTML has no slide list");
        }
        setDeck(parsed);
        setActiveIndex((current) => {
          return Math.min(current, parsed.slides.length - 1);
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setHtmlPreviewFailed(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          setLoadingHtmlPreview(false);
        }
      });
  }, [deck, htmlPreviewFailed, item.embedUrl, loadingHtmlPreview]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!deck) {
      setPreviewFrameUrl(null);
      return;
    }
    const slide = deck.slides[Math.min(activeIndex, deck.slides.length - 1)];
    if (!slide) {
      setPreviewFrameUrl(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob(
        [
          previewPresentationSlideHtml({
            activeSlideId: slide.id,
            html: deck.html,
            sourceUrl: item.embedUrl,
          }),
        ],
        { type: "text/html;charset=utf-8" },
      ),
    );
    setPreviewFrameUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [activeIndex, deck, item.embedUrl]);

  const updateActiveIndex = useCallback(
    (clientX: number, rect: Pick<DOMRect, "left" | "width">) => {
      const index = pointerIndexForClientX({
        clientX,
        count: activeSlideCount,
        rect,
      });
      setActiveIndex((current) => {
        return current === index ? current : index;
      });
    },
    [activeSlideCount],
  );

  return (
    <div
      className="relative aspect-[1280/633] overflow-hidden bg-[hsl(var(--gray-1))]"
      onFocus={loadHtmlPreview}
      onMouseEnter={loadHtmlPreview}
      onPointerMove={(event) => {
        updateActiveIndex(
          event.clientX,
          event.currentTarget.getBoundingClientRect(),
        );
      }}
    >
      <Image
        src={r2ImageTransformUrl(
          fallbackImage,
          PRESENTATION_PREVIEW_IMAGE_SIZE,
        )}
        alt={item.title}
        fill
        sizes="(min-width: 880px) 832px, calc(100vw - 48px)"
        className="object-contain transition-transform duration-300 group-hover:scale-[1.03]"
      />
      {previewFrameUrl ? (
        <iframe
          title={`${item.title} HTML preview`}
          src={previewFrameUrl}
          sandbox="allow-same-origin"
          className="pointer-events-none absolute inset-0 h-full w-full border-0 bg-white transition-transform duration-300 group-hover:scale-[1.03]"
        />
      ) : null}
      {loadingHtmlPreview && !previewFrameUrl ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-black/10">
          <div className="h-full w-1/3 animate-pulse bg-black/30" />
        </div>
      ) : null}
      <div className="pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 text-[12px] font-medium text-[hsl(var(--foreground))] opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.14)] transition-opacity duration-200 group-hover:opacity-100">
        <IconExternalLink size={14} stroke={2} />
        View
      </div>
    </div>
  );
}

function PresentationCard({
  item,
  appUrl,
  landingSearch,
}: {
  item: PresentationItem;
  appUrl: string;
  landingSearch: string;
}) {
  const remixHref = buildPresentationRemixHref(item, appUrl, landingSearch);

  return (
    <article
      id={item.slug}
      className="overflow-hidden rounded-[14px] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-all duration-300 hover:shadow-[0_16px_36px_rgba(0,0,0,0.12)]"
    >
      <a
        href={item.embedUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`View ${item.title} in a new tab`}
        className="group block"
        style={{ textDecoration: "none" }}
      >
        <PresentationPreview item={item} />
      </a>
      <div className="flex flex-col gap-3 px-4 py-3">
        <CopyablePrompt prompt={item.prompt} />
        <a
          href={remixHref}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[8px] bg-[#ed4e01] px-3.5 text-sm font-medium text-white transition-colors hover:bg-[#d94600]"
        >
          <IconSparkles size={15} stroke={2} />
          Try it
        </a>
      </div>
    </article>
  );
}

export function PresentationClient() {
  const appUrl = getAppUrl();
  const [landingSearch, setLandingSearch] = useState("");

  useEffect(() => {
    setLandingSearch(window.location.search);
  }, []);

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <Particles />

      <section className="hero-section" style={{ paddingBottom: 32 }}>
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
        >
          <h1 className="hero-title">Presentation</h1>
          <p className="hero-description">
            Get a polished deck from a single, short prompt. Focus on your
            content and leave the design and creative work to VM0.
          </p>
        </div>
      </section>

      <section style={{ paddingBottom: 120 }}>
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
          className="flex flex-col items-stretch gap-6"
        >
          {PRESENTATION_ITEMS.map((item) => {
            return (
              <PresentationCard
                key={item.slug}
                item={item}
                appUrl={appUrl}
                landingSearch={landingSearch}
              />
            );
          })}
        </div>
      </section>

      <Footer />
    </div>
  );
}
