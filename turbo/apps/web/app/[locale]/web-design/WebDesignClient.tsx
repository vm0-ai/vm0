"use client";

import Image from "next/image";
import { IconArrowUpRight } from "@tabler/icons-react";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import {
  GALLERY_ITEMS,
  buildGalleryPromptHref,
  type GalleryItem,
} from "./data";

const MAX_WIDTH = 1200;
const PAGE_PADDING = 24;

function GalleryCard({ item, locale }: { item: GalleryItem; locale: string }) {
  const href = buildGalleryPromptHref(item, locale);

  return (
    <article
      id={item.slug}
      className="group overflow-hidden rounded-[14px] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgba(0,0,0,0.12)]"
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${item.title}`}
        className="block"
        style={{ textDecoration: "none" }}
      >
        <div className="relative aspect-[16/10] overflow-hidden bg-[hsl(var(--gray-1))]">
          <div className="absolute inset-y-0 left-0 w-[calc(100%+18px)] transition-transform duration-300 group-hover:scale-[1.03]">
            <Image
              src={item.previewImage}
              alt={item.title}
              fill
              sizes="(min-width: 1024px) 378px, (min-width: 768px) calc(50vw + 18px), calc(100vw + 18px)"
              className="object-cover object-top"
            />
          </div>
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/35 group-hover:opacity-100">
            <div className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-2 text-[13px] font-medium text-[hsl(var(--foreground))] shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
              <IconArrowUpRight size={16} stroke={2} />
              View & remix
            </div>
          </div>
        </div>
      </a>
    </article>
  );
}

export function WebDesignClient({ locale }: { locale: string }) {
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
          <h1 className="hero-title">Website Design</h1>
          <p className="hero-description">
            Image-led website examples you can open, inspect, and remix into
            your own Zero creation.
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
          className="grid grid-cols-1 items-start gap-5 md:grid-cols-2 lg:grid-cols-3"
        >
          {GALLERY_ITEMS.map((item) => {
            return <GalleryCard key={item.slug} item={item} locale={locale} />;
          })}
        </div>
      </section>

      <Footer />
    </div>
  );
}
