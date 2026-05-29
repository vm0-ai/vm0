"use client";

import { IconExternalLink, IconSparkles } from "@tabler/icons-react";
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
  appUrl,
}: {
  item: PresentationItem;
  appUrl: string;
}) {
  const remixHref = buildPresentationRemixHref(item, appUrl);

  return (
    <article
      id={item.slug}
      className="flex flex-col overflow-hidden rounded-[14px] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-all duration-300 hover:shadow-[0_16px_36px_rgba(0,0,0,0.12)]"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-[hsl(var(--gray-1))]">
        <iframe
          src={item.embedUrl}
          title={item.title}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin allow-popups"
          className="absolute inset-0 h-full w-full border-0"
        />
        <a
          href={item.embedUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${item.title} in a new tab`}
          className="absolute right-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 text-[12px] font-medium text-[hsl(var(--foreground))] opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition-opacity duration-200 hover:bg-white group-hover:opacity-100"
        >
          <IconExternalLink size={14} stroke={2} />
          Open
        </a>
      </div>

      <div className="flex flex-1 flex-col gap-3 px-4 py-3">
        <h2 className="text-[14px] font-medium text-[hsl(var(--foreground))]">
          {item.title}
        </h2>
        <pre className="max-h-[120px] flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[hsl(var(--gray-1))] px-3 py-2.5 font-mono text-[12px] leading-[1.5] text-[hsl(var(--muted-foreground))]">
          {item.prompt}
        </pre>
        <a
          href={remixHref}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[8px] bg-[#ed4e01] px-3.5 text-sm font-medium text-white transition-colors hover:bg-[#d94600]"
        >
          <IconSparkles size={15} stroke={2} />
          Prompt remix
        </a>
      </div>
    </article>
  );
}

export function PresentationClient() {
  const appUrl = getAppUrl();

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
            Live presentation decks you can open, watch, and remix into your own
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
          className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"
        >
          {PRESENTATION_ITEMS.map((item) => {
            return (
              <PresentationCard key={item.slug} item={item} appUrl={appUrl} />
            );
          })}
        </div>
      </section>

      <Footer />
    </div>
  );
}
