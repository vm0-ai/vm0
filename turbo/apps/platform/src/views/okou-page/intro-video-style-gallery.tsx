import type { IntroVideoStyle } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { SegmentControl, SegmentControlItem, cn } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import {
  INTRO_VIDEO_STYLE_FORMATS,
  introVideoStyleGallerySignals,
} from "../../signals/okou-page/intro-video-style-gallery.ts";
import { IntroVideoStyleCard } from "./intro-video-style-card.tsx";

function StyleFormatFilter() {
  const { t } = useTranslation();
  const format = useGet(introVideoStyleGallerySignals.format$);
  const setFormat = useSet(introVideoStyleGallerySignals.setFormat$);
  return (
    <SegmentControl
      value={format}
      onValueChange={setFormat}
      className="w-full"
      aria-label={t(($) => {
        return $.chat.introVideo.format.filter;
      })}
    >
      {INTRO_VIDEO_STYLE_FORMATS.map((value) => {
        return (
          <SegmentControlItem
            key={value}
            value={value}
            aria-label={t(($) => {
              return value === "16:9"
                ? $.chat.introVideo.format.landscape
                : $.chat.introVideo.format.portrait;
            })}
            className="min-w-0 flex-1"
          >
            {value}
          </SegmentControlItem>
        );
      })}
    </SegmentControl>
  );
}

export function IntroVideoStyleGallery({
  styles,
  hasNext,
  selectedStyleId,
  onSelect,
}: {
  readonly styles: readonly IntroVideoStyle[];
  readonly hasNext: boolean;
  readonly selectedStyleId: string | undefined;
  readonly onSelect: (style: IntroVideoStyle) => void;
}) {
  const { t } = useTranslation();
  const format = useGet(introVideoStyleGallerySignals.format$);
  const setGalleryRef = useSet(introVideoStyleGallerySignals.setGalleryRef$);
  const matches = styles.filter((style) => {
    return style.aspectRatio === format;
  });
  return (
    <div className="grid gap-4" ref={setGalleryRef}>
      <StyleFormatFilter />
      <div
        className={cn(
          "grid grid-cols-2 items-start gap-2.5 sm:gap-3",
          format === "9:16" ? "sm:grid-cols-4" : "sm:grid-cols-3",
        )}
      >
        {matches.map((style) => {
          return (
            <IntroVideoStyleCard
              key={style.id}
              style={style}
              selected={selectedStyleId === style.id}
              onSelect={() => {
                onSelect(style);
              }}
            />
          );
        })}
      </div>
      {!hasNext && matches.length === 0 ? (
        <p
          role="status"
          className="py-8 text-center text-sm text-muted-foreground"
        >
          {t(($) => {
            return $.chat.introVideo.style.emptyFormat;
          })}
        </p>
      ) : null}
    </div>
  );
}
