import type { IntroVideoStyle } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { SegmentControl, SegmentControlItem } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import {
  INTRO_VIDEO_STYLE_FORMATS,
  introVideoStyleGallerySignals,
} from "../../signals/okou-page/intro-video-style-gallery.ts";
import { IntroVideoStyleCard } from "./intro-video-style-card.tsx";

function styleFormatLabel(
  t: TFunction<"common">,
  format: string | undefined,
): string {
  switch (format) {
    case "all": {
      return t(($) => {
        return $.chat.introVideo.format.all;
      });
    }
    case "16:9": {
      return t(($) => {
        return $.chat.introVideo.format.landscape;
      });
    }
    case "9:16": {
      return t(($) => {
        return $.chat.introVideo.format.portrait;
      });
    }
    case "1:1": {
      return t(($) => {
        return $.chat.introVideo.format.square;
      });
    }
    default: {
      return t(($) => {
        return $.chat.introVideo.format.other;
      });
    }
  }
}

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
            aria-label={styleFormatLabel(t, value)}
            className="min-w-0 flex-1"
          >
            {value === "all" ? styleFormatLabel(t, value) : value}
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
  return (
    <div className="grid gap-4">
      <StyleFormatFilter />
      {["16:9", "9:16", "1:1", undefined].map((ratio) => {
        if (format !== "all" && format !== ratio) {
          return null;
        }
        const matches = styles.filter((style) => {
          return style.aspectRatio === ratio;
        });
        if (matches.length === 0) {
          return null;
        }
        return (
          <section key={ratio ?? "other"} className="grid gap-2.5">
            <h3 className="text-sm font-medium text-muted-foreground">
              {styleFormatLabel(t, ratio)}
            </h3>
            <div className="grid grid-cols-2 items-start gap-2.5 sm:grid-cols-3 sm:gap-3">
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
          </section>
        );
      })}
      {format !== "all" &&
      !hasNext &&
      !styles.some((style) => {
        return style.aspectRatio === format;
      }) ? (
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
