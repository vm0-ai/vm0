import { useGet, useSet } from "ccstate-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@vm0/ui/components/ui/popover";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { useTranslation } from "react-i18next";
import type { ComposerSignals } from "../../signals/zero-page/composer-signals.ts";
import { VideoGenerationOptionsForm } from "./video-generation-options-form.tsx";

function VideoTemplateOptionsForm({
  value,
  onChange,
}: {
  readonly value: GenerationTemplateRequest;
  readonly onChange: (next: GenerationTemplateRequest) => void;
}) {
  if (value.type !== "video") {
    return null;
  }
  const apply = (
    videoOptions: NonNullable<typeof value.selection.videoOptions>,
  ) => {
    onChange({
      ...value,
      selection: {
        ...value.selection,
        videoOptions,
      },
    });
  };

  return (
    <VideoGenerationOptionsForm
      value={value.selection.videoOptions}
      persistModel
      onChange={apply}
    />
  );
}

export function VideoTemplateOptionsPopover({
  signals,
  onChange,
}: {
  readonly signals: ComposerSignals;
  readonly onChange: (next: GenerationTemplateRequest) => void;
}) {
  const { t } = useTranslation();
  const anchor = useGet(signals.template.videoTemplateOptionsAnchor$);
  const value = useGet(signals.template.videoTemplateOptionsValue$);
  const close = useSet(signals.template.closeVideoTemplateOptions$);

  if (!anchor || !value) {
    return null;
  }

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <PopoverAnchor asChild>
        <span
          aria-hidden="true"
          className="pointer-events-none fixed"
          style={{
            left: `${String(anchor.left)}px`,
            top: `${String(anchor.top)}px`,
            width: `${String(anchor.width)}px`,
            height: `${String(anchor.height)}px`,
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-[19rem] rounded-xl p-3"
        aria-label={t(($) => {
          return $.chat.templates.videoOptions;
        })}
      >
        <VideoTemplateOptionsForm value={value} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}
