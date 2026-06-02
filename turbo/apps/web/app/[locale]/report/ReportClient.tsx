"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import { IconExternalLink, IconSparkles } from "@tabler/icons-react";
import { CopyablePrompt } from "../../components/CopyablePrompt";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import { getAppUrl } from "../../../src/lib/zero/url";
import { REPORT_ITEMS, buildReportRemixHref, type ReportItem } from "./data";

const MAX_WIDTH = 880;
const PAGE_PADDING = 24;
const REPORT_PREVIEW_SCROLL_SPEED = 28;

function ReportPreview({ item }: { item: ReportItem }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);

  const stopAutoScroll = () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    lastFrameTimeRef.current = null;
  };

  const scrollStep = (timestamp: number) => {
    const container = containerRef.current;

    if (!container) {
      stopAutoScroll();
      return;
    }

    if (lastFrameTimeRef.current === null) {
      lastFrameTimeRef.current = timestamp;
    }

    const maxScrollTop = container.scrollHeight - container.clientHeight;
    if (maxScrollTop <= 0 || container.scrollTop >= maxScrollTop) {
      stopAutoScroll();
      return;
    }

    const elapsedSeconds = (timestamp - lastFrameTimeRef.current) / 1000;
    container.scrollTop = Math.min(
      maxScrollTop,
      container.scrollTop + elapsedSeconds * REPORT_PREVIEW_SCROLL_SPEED,
    );
    lastFrameTimeRef.current = timestamp;
    frameRef.current = requestAnimationFrame(scrollStep);
  };

  const startAutoScroll = () => {
    if (frameRef.current !== null) {
      return;
    }

    frameRef.current = requestAnimationFrame(scrollStep);
  };

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  return (
    <div
      className="relative max-h-[640px] overflow-hidden bg-[hsl(var(--gray-1))] sm:max-h-[720px]"
      onMouseEnter={startAutoScroll}
      onMouseLeave={stopAutoScroll}
    >
      <div
        ref={containerRef}
        className="max-h-[640px] overflow-hidden sm:max-h-[720px]"
      >
        <Image
          src={item.previewImage}
          alt={item.title}
          width={item.previewWidth}
          height={item.previewHeight}
          sizes="(min-width: 880px) 832px, calc(100vw - 48px)"
          className="block h-auto w-full"
        />
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/35 group-hover:opacity-100">
        <div className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-2 text-[13px] font-medium text-[hsl(var(--foreground))] shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
          <IconExternalLink size={16} stroke={2} />
          View
        </div>
      </div>
    </div>
  );
}

function ReportCard({ item, appUrl }: { item: ReportItem; appUrl: string }) {
  const remixHref = buildReportRemixHref(item, appUrl);

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
        <ReportPreview item={item} />
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

export function ReportClient() {
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
          <h1 className="hero-title">Report</h1>
          <p className="hero-description">
            Get a polished report from a single, short prompt. Focus on the
            brief and leave the structure, visuals, and writing to VM0.
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
          {REPORT_ITEMS.map((item) => {
            return <ReportCard key={item.slug} item={item} appUrl={appUrl} />;
          })}
        </div>
      </section>

      <Footer />
    </div>
  );
}
