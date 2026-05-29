"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { IconExternalLink, IconSparkles, IconX } from "@tabler/icons-react";
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

function PresentationCard({
  item,
  onOpen,
}: {
  item: PresentationItem;
  onOpen: (item: PresentationItem) => void;
}) {
  return (
    <article
      id={item.slug}
      className="flex flex-col overflow-hidden rounded-[14px] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-all duration-300 hover:shadow-[0_16px_36px_rgba(0,0,0,0.12)]"
    >
      <button
        type="button"
        onClick={() => {
          onOpen(item);
        }}
        aria-label={`Open ${item.title}`}
        className="group relative block aspect-[1280/633] w-full overflow-hidden bg-[hsl(var(--gray-1))]"
      >
        <Image
          src={item.previewImage}
          alt={item.title}
          fill
          sizes="(min-width: 640px) 50vw, 100vw"
          className="object-contain transition-transform duration-300 group-hover:scale-[1.03]"
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/35 group-hover:opacity-100">
          <div className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-2 text-[13px] font-medium text-[hsl(var(--foreground))] shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
            <IconExternalLink size={16} stroke={2} />
            Preview
          </div>
        </div>
      </button>
    </article>
  );
}

function PresentationLightbox({
  item,
  appUrl,
  onClose,
}: {
  item: PresentationItem;
  appUrl: string;
  onClose: () => void;
}) {
  const remixHref = buildPresentationRemixHref(item, appUrl);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.title}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <div
        onClick={(event) => {
          event.stopPropagation();
        }}
        className="flex max-h-[92vh] w-full max-w-[1100px] flex-col overflow-y-auto rounded-[16px] bg-white shadow-[0_24px_64px_rgba(0,0,0,0.35)]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--gray-1))] px-4 py-3">
          <h2 className="truncate text-[15px] font-medium text-[hsl(var(--foreground))]">
            {item.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--gray-1))]"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>

        <div className="relative aspect-[1280/633] w-full bg-[hsl(var(--gray-1))]">
          <iframe
            src={item.embedUrl}
            title={item.title}
            sandbox="allow-scripts allow-same-origin allow-popups"
            className="absolute inset-0 h-full w-full border-0"
          />
        </div>

        <div className="flex flex-col gap-3 border-t border-[hsl(var(--gray-1))] px-4 py-4">
          <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[hsl(var(--gray-1))] px-3 py-2.5 font-mono text-[12px] leading-[1.5] text-[hsl(var(--muted-foreground))]">
            {item.prompt}
          </pre>
          <div className="flex items-center justify-between gap-3">
            <a
              href={item.embedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--foreground))]"
            >
              <IconExternalLink size={15} stroke={2} />
              Open full deck
            </a>
            <a
              href={remixHref}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[8px] bg-[#ed4e01] px-3.5 text-sm font-medium text-white transition-colors hover:bg-[#d94600]"
            >
              <IconSparkles size={15} stroke={2} />
              Prompt remix
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PresentationClient() {
  const appUrl = getAppUrl();
  const [activeItem, setActiveItem] = useState<PresentationItem | null>(null);

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
            Presentation decks you can preview, open, and remix into your own
            Zero creation.
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
          className="grid grid-cols-1 gap-6 sm:grid-cols-2"
        >
          {PRESENTATION_ITEMS.map((item) => {
            return (
              <PresentationCard
                key={item.slug}
                item={item}
                onOpen={setActiveItem}
              />
            );
          })}
        </div>
      </section>

      <Footer />

      {activeItem ? (
        <PresentationLightbox
          item={activeItem}
          appUrl={appUrl}
          onClose={() => {
            setActiveItem(null);
          }}
        />
      ) : null}
    </div>
  );
}
