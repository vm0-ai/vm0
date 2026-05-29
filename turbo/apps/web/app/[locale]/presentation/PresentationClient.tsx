"use client";

import Image from "next/image";
import { IconExternalLink, IconSparkles } from "@tabler/icons-react";
import { CopyablePrompt } from "../../components/CopyablePrompt";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import { getAppUrl } from "../../../src/lib/zero/url";
import {
  PRESENTATION_ITEMS,
  buildPresentationRemixHref,
  type PresentationItem,
} from "./data";

const MAX_WIDTH = 880;
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
        <div className="relative aspect-[1280/633] overflow-hidden bg-[hsl(var(--gray-1))]">
          <Image
            src={item.previewImage}
            alt={item.title}
            fill
            sizes="(min-width: 880px) 832px, calc(100vw - 48px)"
            className="object-contain transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/35 group-hover:opacity-100">
            <div className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-2 text-[13px] font-medium text-[hsl(var(--foreground))] shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
              <IconExternalLink size={16} stroke={2} />
              View
            </div>
          </div>
        </div>
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
              <PresentationCard key={item.slug} item={item} appUrl={appUrl} />
            );
          })}
        </div>
      </section>

      <Footer />
    </div>
  );
}
