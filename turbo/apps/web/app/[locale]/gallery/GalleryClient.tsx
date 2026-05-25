"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import { getAppUrl } from "../../../src/lib/zero/url";
import {
  GALLERY_CATEGORIES,
  GALLERY_CATEGORY_LABELS,
  GALLERY_ITEMS,
  buildGalleryPromptHref,
  type GalleryCategory,
  type GalleryItem,
} from "./data";

const MAX_WIDTH = 1200;
const PAGE_PADDING = 24;

type GalleryFilter = GalleryCategory | "all";

function GalleryCard({ item }: { item: GalleryItem }) {
  const href = buildGalleryPromptHref(item, getAppUrl());

  return (
    <article
      id={item.slug}
      className="group overflow-hidden rounded-[20px] bg-white transition-all duration-300 hover:-translate-y-0.5"
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block text-[hsl(var(--foreground))]"
        style={{ textDecoration: "none" }}
      >
        <div className="relative aspect-[16/10] overflow-hidden bg-[hsl(var(--gray-1))]">
          <Image
            src={item.previewImage}
            alt=""
            fill
            sizes="(min-width: 1024px) 360px, (min-width: 768px) 50vw, 100vw"
            className="object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <div className="absolute left-4 top-4 rounded-[6px] bg-white/90 px-2.5 py-1 text-[12px] font-medium uppercase tracking-[0.04em] text-[hsl(var(--foreground))]">
            {GALLERY_CATEGORY_LABELS[item.category]}
          </div>
          <div className="absolute bottom-4 right-4 rounded-[6px] bg-black/80 px-2.5 py-1 text-[12px] font-medium text-white">
            {item.generationKind}
          </div>
        </div>

        <div className="flex min-h-[210px] flex-col px-6 pb-7 pt-5">
          <h2 className="text-[20px] font-medium leading-snug tracking-[-0.2px] text-[hsl(var(--foreground))] group-hover:text-[#ed4e01]">
            {item.title}
          </h2>
          <p className="mt-3 text-[15px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
            {item.description}
          </p>
          <div className="mt-auto pt-5">
            <span className="inline-flex items-center gap-1 text-[14px] font-medium text-[#ed4e01] transition-all group-hover:gap-2">
              Remix prompt
              <span aria-hidden="true">→</span>
            </span>
          </div>
        </div>
      </a>
    </article>
  );
}

export function GalleryClient() {
  const [activeFilter, setActiveFilter] = useState<GalleryFilter>("all");

  const visibleItems = useMemo(() => {
    if (activeFilter === "all") return GALLERY_ITEMS;
    return GALLERY_ITEMS.filter((item) => {
      return item.category === activeFilter;
    });
  }, [activeFilter]);

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
          <h1 className="hero-title">Generation Gallery</h1>
          <p className="hero-description">
            Prompt-first examples for remixing images, presentations, websites,
            reports, videos, and audio through Zero onboarding.
          </p>
        </div>
      </section>

      <section style={{ paddingBottom: 32 }}>
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
        >
          <div
            className="flex flex-wrap gap-2"
            role="tablist"
            aria-label="Gallery categories"
          >
            {GALLERY_CATEGORIES.map((category) => {
              const isActive = activeFilter === category;
              return (
                <button
                  key={category}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`uc-pill${isActive ? " uc-pill--active" : ""}`}
                  onClick={() => {
                    setActiveFilter(category);
                  }}
                >
                  {GALLERY_CATEGORY_LABELS[category]}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section style={{ paddingBottom: 120 }}>
        <div
          style={{
            maxWidth: MAX_WIDTH,
            margin: "0 auto",
            padding: `0 ${PAGE_PADDING}px`,
          }}
          className="grid grid-cols-1 items-start gap-5 md:grid-cols-2 lg:grid-cols-3"
        >
          {visibleItems.map((item) => {
            return <GalleryCard key={item.slug} item={item} />;
          })}
        </div>
      </section>

      <Footer />
    </div>
  );
}
