"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { IconCheck, IconExternalLink, IconSparkles } from "@tabler/icons-react";
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

const MAX_WIDTH = 1200;
const PAGE_PADDING = 24;
const PRESENTATION_PREVIEW_IMAGE_SIZE = { width: 1920, height: 1080 } as const;
const PRESENTATION_THUMBNAIL_IMAGE_SIZE = {
  width: 320,
  height: 180,
} as const;

function presentationSlideImages(item: PresentationItem): readonly string[] {
  return item.previewImages.length > 0
    ? item.previewImages
    : [item.previewImage];
}

function formatSlideCounter(index: number, total: number): string {
  const width = Math.max(2, String(total).length);
  return `${String(index + 1).padStart(width, "0")} / ${String(total).padStart(
    width,
    "0",
  )}`;
}

function PresentationCard({
  item,
  appUrl,
  landingSearch,
  priority,
}: {
  item: PresentationItem;
  appUrl: string;
  landingSearch: string;
  priority?: boolean;
}) {
  const slides = presentationSlideImages(item);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [promptOpen, setPromptOpen] = useState(false);
  const remixHref = buildPresentationRemixHref(item, appUrl, landingSearch);
  const activeSlide = slides[activeSlideIndex] ?? item.previewImage;
  const slideCounter = formatSlideCounter(activeSlideIndex, slides.length);

  return (
    <article
      id={item.slug}
      className="overflow-hidden rounded-[18px] border border-[hsl(var(--gray-200))] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
    >
      <div className="flex flex-col gap-3 border-b border-[hsl(var(--gray-200))] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#ed4e01]" />
          <h2 className="truncate text-[18px] font-semibold leading-7 text-[hsl(var(--foreground))] sm:text-[20px]">
            {item.title}
          </h2>
          <span className="shrink-0 font-mono text-[18px] leading-7 text-[hsl(var(--muted-foreground))]">
            {slideCounter}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setPromptOpen((open) => {
                return !open;
              });
            }}
            className={`inline-flex h-9 items-center justify-center rounded-[10px] border px-3.5 text-sm font-medium transition-colors ${
              promptOpen
                ? "border-[hsl(var(--foreground))] bg-[hsl(var(--foreground))] text-white"
                : "border-[hsl(var(--gray-200))] bg-white text-[hsl(var(--foreground))] hover:bg-[hsl(var(--gray-50))]"
            }`}
            aria-expanded={promptOpen}
          >
            Prompt
          </button>
          <a
            href={remixHref}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[10px] bg-[#ed4e01] px-3.5 text-sm font-medium text-white transition-colors hover:bg-[#d94600]"
          >
            <IconSparkles size={15} stroke={2} />
            Try it
          </a>
          <a
            href={item.embedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[10px] border border-[hsl(var(--gray-200))] bg-white px-3.5 text-sm font-medium text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--gray-50))]"
          >
            <IconExternalLink size={15} stroke={2} />
            Open full screen
          </a>
        </div>
      </div>
      <a
        href={item.embedUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${item.title} in full screen`}
        className="group block"
        style={{ textDecoration: "none" }}
      >
        <div className="relative aspect-video overflow-hidden bg-[#050505]">
          <Image
            src={r2ImageTransformUrl(
              activeSlide,
              PRESENTATION_PREVIEW_IMAGE_SIZE,
            )}
            alt={`${item.title} slide ${activeSlideIndex + 1}`}
            fill
            priority={priority}
            sizes="(min-width: 1200px) 1152px, calc(100vw - 48px)"
            className="object-contain"
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/25 group-hover:opacity-100">
            <div className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-2 text-[13px] font-medium text-[hsl(var(--foreground))] shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
              <IconExternalLink size={16} stroke={2} />
              Open full screen
            </div>
          </div>
        </div>
      </a>
      <div className="bg-white px-4 py-4">
        <div
          className="flex gap-3 overflow-x-auto pb-3"
          aria-label={`${item.title} slide thumbnails`}
        >
          {slides.map((slide, index) => {
            const active = index === activeSlideIndex;

            return (
              <button
                key={slide}
                type="button"
                onClick={() => {
                  setActiveSlideIndex(index);
                }}
                aria-label={`Show slide ${index + 1} of ${slides.length}`}
                aria-pressed={active}
                className={`relative h-[72px] w-[128px] shrink-0 overflow-hidden rounded-[10px] border bg-[hsl(var(--gray-1))] transition-colors hover:border-[#ed4e01] sm:h-[90px] sm:w-[160px] ${
                  active
                    ? "border-[#ed4e01] ring-2 ring-[#ed4e01]/20"
                    : "border-[hsl(var(--gray-200))]"
                }`}
              >
                <Image
                  src={r2ImageTransformUrl(
                    slide,
                    PRESENTATION_THUMBNAIL_IMAGE_SIZE,
                  )}
                  alt=""
                  fill
                  sizes="160px"
                  className="object-cover"
                />
                {active ? (
                  <span className="absolute right-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#ed4e01] text-white">
                    <IconCheck size={13} stroke={2.4} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      {promptOpen ? (
        <div className="border-t border-[hsl(var(--gray-200))] bg-[hsl(var(--gray-0))] px-4 py-4">
          <CopyablePrompt prompt={item.prompt} />
        </div>
      ) : null}
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

      <section
        className="hero-section"
        style={{
          paddingBottom: 32,
        }}
      >
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
        >
          <h1 className="hero-title">Presentation</h1>
          <p className="hero-description">
            Browse default HTML presentation templates, inspect their slides,
            and remix the prompt in Zero.
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
          {PRESENTATION_ITEMS.map((item, index) => {
            return (
              <PresentationCard
                key={item.slug}
                item={item}
                appUrl={appUrl}
                landingSearch={landingSearch}
                priority={index === 0}
              />
            );
          })}
        </div>
      </section>

      <Footer />
    </div>
  );
}
