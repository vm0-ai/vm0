import type { IntroVideoStyle } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { cn } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { Check, LayoutTemplate, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

import { introVideoStyleGallerySignals } from "../../signals/okou-page/intro-video-style-gallery.ts";

function StylePreviewMedia({ style }: { readonly style: IntroVideoStyle }) {
  const { t } = useTranslation();
  const previewId = useGet(introVideoStyleGallerySignals.previewId$);
  const previewStyle = useSet(introVideoStyleGallerySignals.previewStyle$);
  if (previewId === style.id && style.previewVideoUrl) {
    return (
      <>
        <video
          src={style.previewVideoUrl}
          poster={style.thumbnailUrl}
          controls
          autoPlay
          muted
          playsInline
          preload="metadata"
          aria-label={style.name}
          className="peer h-full w-full object-contain data-[failed=true]:hidden"
          onError={(event) => {
            event.currentTarget.dataset.failed = "true";
          }}
        />
        <p
          role="status"
          className="hidden p-3 text-sm text-muted-foreground peer-data-[failed=true]:block"
        >
          {t(($) => {
            return $.chat.introVideo.style.previewUnavailable;
          })}
        </p>
      </>
    );
  }
  return (
    <>
      {style.thumbnailUrl ? (
        <img
          src={style.thumbnailUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain"
        />
      ) : (
        <span className="grid h-full place-items-center text-muted-foreground">
          <LayoutTemplate size={28} />
        </span>
      )}
      {style.previewVideoUrl ? (
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.chat.introVideo.style.preview;
            },
            { title: style.name },
          )}
          onClick={() => {
            previewStyle(style.id);
          }}
          className="absolute inset-0 grid place-items-center bg-black/10 text-white transition-colors hover:bg-black/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="grid size-11 place-items-center rounded-full bg-black/55">
            <Play size={20} fill="currentColor" />
          </span>
        </button>
      ) : null}
    </>
  );
}

export function IntroVideoStyleCard({
  style,
  selected,
  onSelect,
}: {
  readonly style: IntroVideoStyle;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/20",
        selected ? "border-primary" : "border-border",
      )}
    >
      <div
        className="relative overflow-hidden bg-muted"
        style={{ aspectRatio: style.aspectRatio?.replace(":", "/") }}
      >
        <StylePreviewMedia style={style} />
      </div>
      <button
        type="button"
        aria-label={t(
          ($) => {
            return $.artifacts.templates.selectStyle;
          },
          { style: style.name },
        )}
        aria-pressed={selected}
        onClick={onSelect}
        className="flex min-h-12 w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <strong className="min-w-0 flex-1 text-sm font-medium text-foreground">
          {style.name}
        </strong>
        {selected ? (
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
            <Check size={12} />
          </span>
        ) : null}
      </button>
    </div>
  );
}
