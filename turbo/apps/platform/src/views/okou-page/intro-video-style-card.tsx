import type { IntroVideoStyle } from "@okouai/api-contracts/contracts/intro-video-presenter";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  cn,
} from "@okouai/ui";
import { Check, LayoutTemplate, Maximize2, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

function StylePreviewMedia({ style }: { readonly style: IntroVideoStyle }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 justify-center overflow-hidden rounded-xl bg-muted">
      {style.previewVideoUrl ? (
        <video
          src={style.previewVideoUrl}
          poster={style.thumbnailUrl}
          controls
          autoPlay
          muted
          playsInline
          preload="metadata"
          aria-label={style.name}
          className="peer max-h-[60dvh] w-full object-contain data-[failed=true]:hidden"
          onError={(event) => {
            event.currentTarget.dataset.failed = "true";
          }}
        />
      ) : (
        <div className="grid justify-items-center gap-3 p-4">
          {style.thumbnailUrl ? (
            <img
              src={style.thumbnailUrl}
              alt={style.name}
              className="max-h-[50dvh] max-w-full object-contain"
            />
          ) : null}
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.chat.introVideo.style.previewUnavailable;
            })}
          </p>
        </div>
      )}
      {style.previewVideoUrl ? (
        <p
          role="status"
          className="hidden p-4 text-sm text-muted-foreground peer-data-[failed=true]:block"
        >
          {t(($) => {
            return $.chat.introVideo.style.previewUnavailable;
          })}
        </p>
      ) : null}
    </div>
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
  const selectLabel = t(
    ($) => {
      return $.artifacts.templates.selectStyle;
    },
    { style: style.name },
  );
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/20",
        selected ? "border-primary" : "border-border",
      )}
    >
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label={t(
              ($) => {
                return $.chat.introVideo.style.preview;
              },
              { title: style.name },
            )}
            className="group relative block w-full overflow-hidden bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            style={{
              aspectRatio: style.aspectRatio?.replace(":", "/") ?? "1/1",
            }}
          >
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
            <span className="absolute inset-0 grid place-items-center bg-black/10 text-white transition-colors group-hover:bg-black/25">
              <span className="grid size-11 place-items-center rounded-full bg-black/55">
                {style.previewVideoUrl ? (
                  <Play size={20} fill="currentColor" />
                ) : (
                  <Maximize2 size={20} />
                )}
              </span>
            </span>
            {style.aspectRatio ? (
              <span className="absolute bottom-2 right-2 rounded-md bg-black/65 px-2 py-1 text-xs font-medium text-white">
                {style.aspectRatio}
              </span>
            ) : null}
          </button>
        </DialogTrigger>
        <DialogContent className="okou-app flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
          <DialogHeader className="pr-6 text-left">
            <DialogTitle>{style.name}</DialogTitle>
            <DialogDescription>
              {t(($) => {
                return $.chat.introVideo.style.help;
              })}
            </DialogDescription>
          </DialogHeader>
          <StylePreviewMedia style={style} />
          <Button type="button" onClick={onSelect} className="self-end">
            {selectLabel}
          </Button>
        </DialogContent>
      </Dialog>
      <button
        type="button"
        aria-label={selectLabel}
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
