"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { IconPlayerPlay, IconSparkles } from "@tabler/icons-react";
import { CopyablePrompt } from "../../components/CopyablePrompt";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import { getAppUrl } from "../../../src/lib/zero/url";
import { VIDEO_ITEMS, buildVideoRemixHref, type VideoItem } from "./data";

const MAX_WIDTH = 880;
const PAGE_PADDING = 24;

function VideoPreview({ item }: { item: VideoItem }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const playPreview = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    video.muted = true;
    video.playsInline = true;
    setIsPlaying(true);
    void video.play().catch(() => {
      setIsPlaying(false);
    });
  }, []);

  const resetPreview = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    video.pause();
    video.currentTime = 0;
    setIsPlaying(false);
  }, []);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Play ${item.title} preview`}
      className="group relative aspect-video w-full cursor-pointer overflow-hidden bg-[hsl(var(--gray-1))]"
      onClick={playPreview}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          playPreview();
        }
      }}
      onMouseEnter={playPreview}
      onMouseLeave={resetPreview}
      onPointerEnter={playPreview}
      onPointerLeave={resetPreview}
      onTouchStart={playPreview}
    >
      <Image
        src={item.previewImage}
        alt={item.title}
        fill
        sizes="(min-width: 880px) 832px, calc(100vw - 48px)"
        className="pointer-events-none object-cover"
      />
      <video
        ref={videoRef}
        className={`pointer-events-none absolute inset-0 h-full w-full bg-black object-contain transition-opacity duration-300 ${
          isPlaying ? "opacity-100" : "opacity-0"
        }`}
        poster={item.previewImage}
        muted
        loop
        playsInline
        preload="auto"
        src={item.previewVideo}
      />
      <div
        className={`pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-200 ${
          isPlaying ? "opacity-0" : "opacity-100"
        }`}
      >
        <div className="inline-flex size-14 items-center justify-center rounded-full bg-white/90 text-[hsl(var(--foreground))] shadow-[0_10px_30px_rgba(0,0,0,0.24)] backdrop-blur-sm">
          <IconPlayerPlay size={24} stroke={2} />
        </div>
      </div>
    </div>
  );
}

function VideoCard({
  item,
  appUrl,
  landingSearch,
}: {
  item: VideoItem;
  appUrl: string;
  landingSearch: string;
}) {
  const remixHref = buildVideoRemixHref(item, appUrl, landingSearch);

  return (
    <article
      id={item.slug}
      className="overflow-hidden rounded-[14px] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
    >
      <VideoPreview item={item} />
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-[17px] font-semibold leading-tight text-[hsl(var(--foreground))]">
            {item.title}
          </h2>
          <p className="text-sm leading-6 text-[hsl(var(--muted-foreground))]">
            {item.description}
          </p>
        </div>
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

export function VideoClient() {
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
          <h1 className="hero-title">Video</h1>
          <p className="hero-description">
            Generate short videos from templates. Pick a style, remix the
            prompt, and let VM0 handle the motion, pacing, and polish.
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
          {VIDEO_ITEMS.map((item) => {
            return (
              <VideoCard
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
