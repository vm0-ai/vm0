import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { SwatchBook } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { findVideoTemplateItem, r2ImageTransformUrl } from "@vm0/core";
import {
  VIDEO_MODEL_CONFIGS,
  resolveVideoGenerationOptions,
} from "@vm0/core/video-model-catalog";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import {
  closeSentTemplateDetail$,
  sentTemplateDetail$,
} from "../../signals/zero-page/sent-template-detail.ts";

function SentVideoTemplateDetail({
  titleSnapshot,
  template,
}: {
  readonly titleSnapshot: string;
  readonly template: Extract<GenerationTemplateRequest, { type: "video" }>;
}) {
  const { t } = useTranslation();
  const item = findVideoTemplateItem(template.selection.stylePresetId);
  const resolved = resolveVideoGenerationOptions(
    template.selection.videoOptions,
  );
  const config = VIDEO_MODEL_CONFIGS[resolved.model];
  const audio = resolved.generateAudio
    ? t(($) => {
        return $.chat.templates.videoSpecAudioOn;
      })
    : t(($) => {
        return $.chat.templates.videoSpecAudioOff;
      });
  const rows: readonly { label: string; value: string }[] = [
    {
      label: t(($) => {
        return $.chat.templates.videoOptionsModel;
      }),
      value: config.label,
    },
    {
      label: t(($) => {
        return $.chat.templates.videoOptionsRatio;
      }),
      value: resolved.aspectRatio,
    },
    {
      label: t(($) => {
        return $.chat.templates.videoOptionsDuration;
      }),
      value: resolved.duration,
    },
    {
      label: t(($) => {
        return $.chat.templates.videoOptionsResolution;
      }),
      value: resolved.resolution,
    },
    ...(config.supportsGenerateAudio
      ? [
          {
            label: t(($) => {
              return $.chat.templates.videoOptionsAudio;
            }),
            value: audio,
          },
        ]
      : []),
  ];
  return (
    <>
      <DialogHeader className="text-left">
        <DialogTitle className="flex min-w-0 items-center gap-1.5 pr-8 text-base">
          <SwatchBook
            size={15}
            className="shrink-0 text-orange-600 dark:text-orange-300"
          />
          <span className="min-w-0 truncate">{titleSnapshot}</span>
        </DialogTitle>
      </DialogHeader>
      {item && (
        <img
          src={r2ImageTransformUrl(item.cardPreviewImage ?? item.previewImage, {
            width: 768,
            height: 432,
          })}
          alt=""
          aria-hidden="true"
          className="aspect-video w-full rounded-lg bg-muted object-cover"
        />
      )}
      <div className="flex flex-col">
        {rows.map((row) => {
          return (
            <div
              key={row.label}
              className="flex items-center justify-between gap-3 py-1.5"
            >
              <span className="text-sm text-muted-foreground">{row.label}</span>
              <span className="text-sm">{row.value}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * Read-only echo of a sent video template, opened by tapping the message
 * chip — a button only on touch-width viewports, where the chip hides its
 * inline spec. Docks to the bottom edge; the sm: styles only cover a dialog
 * kept open while the viewport is resized past the breakpoint.
 */
export function SentTemplateDetailDialog() {
  const { t } = useTranslation();
  const detail = useGet(sentTemplateDetail$);
  const close = useSet(closeSentTemplateDetail$);
  if (detail === null || detail.template.type !== "video") {
    return null;
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        closeLabel={t(($) => {
          return $.artifacts.actions.close;
        })}
        // The kit's close button (size-9 box around a 20px glyph at right-4
        // top-4) lines its glyph up with a p-6 content box; this sheet uses
        // p-4, so shift it to keep the glyph on the content edge, centered
        // on the title row.
        className="bottom-0 left-0 right-0 top-auto max-w-none translate-x-0 translate-y-0 gap-3 rounded-b-none rounded-t-2xl p-4 pb-[calc(1rem+var(--sab))] [&>button]:right-2 [&>button]:top-2.5 sm:bottom-auto sm:left-[50%] sm:right-auto sm:top-[50%] sm:max-w-sm sm:translate-x-[-50%] sm:translate-y-[-50%] sm:gap-4 sm:rounded-xl sm:p-6 sm:[&>button]:right-4 sm:[&>button]:top-4"
      >
        <SentVideoTemplateDetail
          titleSnapshot={detail.titleSnapshot}
          template={detail.template}
        />
      </DialogContent>
    </Dialog>
  );
}
