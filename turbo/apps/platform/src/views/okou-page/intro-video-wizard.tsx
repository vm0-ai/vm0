import type {
  ChangeEvent as ReactChangeEvent,
  CSSProperties,
  ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clapperboard,
  Download,
  FileText,
  MonitorUp,
  Play,
  RefreshCw,
  Upload,
  UserRound,
  Video,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Textarea,
  cn,
} from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { computerUseProductName$ } from "../../signals/branding.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  desktopDownloadSupportStatus$,
  OKOU_DESKTOP_DOWNLOAD_URL,
} from "../../signals/okou-page/computer-use-hosts.ts";
import {
  introVideoSourceStep,
  introVideoWizardSignals,
  isIntroVideoDocument,
  type IntroVideoPlacement,
  type IntroVideoSource,
  type IntroVideoVoiceSelection,
  type IntroVideoWizardError,
  INTRO_VIDEO_ASPECT_RATIO_LABEL,
  type IntroVideoWizardStep,
} from "../../signals/okou-page/intro-video.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  AvatarLibraryContent,
  VoiceLibraryContent,
  VoiceLibraryToolbar,
} from "./avatar-template-picker.tsx";

const DOCUMENT_ACCEPT =
  ".html,.pdf,.ppt,.pptx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/html";
const DOCUMENT_INPUT_SELECTOR = '[data-intro-video-document-input=""]';

function wizardStage(step: IntroVideoWizardStep): number {
  switch (step) {
    case "avatar": {
      return 1;
    }
    case "voice": {
      return 2;
    }
    case "review": {
      return 3;
    }
    default: {
      return 0;
    }
  }
}

function stepForStage(
  stage: number,
  source: IntroVideoSource | null,
): IntroVideoWizardStep {
  switch (stage) {
    case 1: {
      return "avatar";
    }
    case 2: {
      return "voice";
    }
    case 3: {
      return "review";
    }
    default: {
      return introVideoSourceStep(source);
    }
  }
}

/**
 * Navigate to a step.
 *
 * Reaching the source step goes through `returnToSourceStep$`, which owns the
 * rule about what happens to the source the wizard is leaving behind: a deck
 * skips the review page, so giving it up is the only way back to step one,
 * while a desktop take the browser cannot recreate is kept.
 */
function useGoToStep(): (step: IntroVideoWizardStep) => void {
  const pageSignal = useGet(pageSignal$);
  const setStep = useSet(introVideoWizardSignals.setStep$);
  const returnToSourceStep = useSet(
    introVideoWizardSignals.returnToSourceStep$,
  );
  return (step) => {
    if (step === "source") {
      detach(
        returnToSourceStep(pageSignal),
        Reason.DomCallback,
        "return to the intro video source step",
      );
      return;
    }
    setStep(step);
  };
}

function formatBytes(size: number): string {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function sourceFormat(source: IntroVideoSource): string {
  const extension = source.name.split(".").pop()?.toLocaleUpperCase();
  return extension || source.contentType;
}

function sourceSavedLabel(
  t: TFunction<"common">,
  source: IntroVideoSource,
  persisted: boolean,
): string {
  if (source.origin === "uploaded") {
    return t(($) => {
      return $.chat.introVideo.sourceReview.inAccount;
    });
  }
  return persisted
    ? t(($) => {
        return $.chat.introVideo.sourceReview.inBrowser;
      })
    : t(($) => {
        return $.chat.introVideo.sourceReview.inTab;
      });
}

function sourceKindLabel(
  t: TFunction<"common">,
  source: IntroVideoSource,
): string {
  switch (source.kind) {
    case "document": {
      return t(($) => {
        return $.chat.introVideo.source.documentTitle;
      });
    }
    case "recording": {
      return t(($) => {
        return $.chat.introVideo.source.recordTitle;
      });
    }
  }
}

function voiceLabel(
  t: TFunction<"common">,
  selection: IntroVideoVoiceSelection | null,
): string {
  switch (selection?.kind) {
    case "catalog": {
      return selection.voice.name;
    }
    case "original": {
      return t(($) => {
        return $.chat.introVideo.voice.original;
      });
    }
    case "none": {
      return t(($) => {
        return $.chat.introVideo.voice.none;
      });
    }
    default: {
      return "—";
    }
  }
}

function WizardStepButton({
  active,
  completed,
  disabled,
  index,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly completed: boolean;
  readonly disabled: boolean;
  readonly index: number;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "step" : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-primary/10 text-primary"
          : completed
            ? "text-foreground hover:bg-state-hover"
            : "text-muted-foreground hover:bg-state-hover disabled:pointer-events-none disabled:opacity-45",
      )}
    >
      <span
        className={cn(
          "grid size-5 place-items-center rounded-full border text-[10px]",
          active
            ? "border-primary bg-primary text-primary-foreground"
            : completed
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-border bg-background",
        )}
      >
        {completed ? <Check size={11} /> : index + 1}
      </span>
      {label}
    </button>
  );
}

function SourceChoice({
  description,
  detail,
  icon,
  title,
  onClick,
}: {
  readonly description: string;
  readonly detail?: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-32 min-w-0 items-start gap-4 rounded-xl border border-border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">
          {title}
        </span>
        <span className="mt-1 block text-sm leading-5 text-muted-foreground">
          {description}
        </span>
        {detail ? (
          <span className="mt-2 block text-xs text-muted-foreground/80">
            {detail}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function clickFileInput(selector: string): void {
  document.querySelector<HTMLInputElement>(selector)?.click();
}

function SourceOptions({
  desktopProductName,
  onRecord,
}: {
  readonly desktopProductName: string;
  readonly onRecord: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <SourceChoice
        title={t(($) => {
          return $.chat.introVideo.source.documentTitle;
        })}
        description={t(($) => {
          return $.chat.introVideo.source.documentDescription;
        })}
        detail={t(($) => {
          return $.chat.introVideo.source.documentFormats;
        })}
        icon={<FileText size={21} />}
        onClick={() => {
          clickFileInput(DOCUMENT_INPUT_SELECTOR);
        }}
      />
      <SourceChoice
        title={t(($) => {
          return $.chat.introVideo.source.recordTitle;
        })}
        description={t(($) => {
          return $.chat.introVideo.source.recordDescription;
        })}
        detail={t(
          ($) => {
            return $.chat.introVideo.source.recordDetail;
          },
          { desktopProductName },
        )}
        icon={<MonitorUp size={21} />}
        onClick={onRecord}
      />
      <SourceChoice
        title={t(($) => {
          return $.chat.introVideo.source.uploadTitle;
        })}
        description={t(($) => {
          return $.chat.introVideo.source.uploadDescription;
        })}
        icon={<Upload size={21} />}
        onClick={() => {
          clickFileInput(DOCUMENT_INPUT_SELECTOR);
        }}
      />
    </div>
  );
}

function SourcePage() {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const desktopProductName = useGet(computerUseProductName$);
  const setSourceFile = useSet(introVideoWizardSignals.setSourceFile$);
  const setStep = useSet(introVideoWizardSignals.setStep$);

  const handleFileChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !isIntroVideoDocument(file)) {
      return;
    }
    detach(
      setSourceFile(file, pageSignal),
      Reason.DomCallback,
      "select intro video source",
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col">
      <h3 className="text-xl font-semibold tracking-tight text-foreground">
        {t(($) => {
          return $.chat.introVideo.source.heading;
        })}
      </h3>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        {t(
          ($) => {
            return $.chat.introVideo.source.help;
          },
          { desktopProductName },
        )}
      </p>
      <SourceOptions
        desktopProductName={desktopProductName}
        onRecord={() => {
          setStep("desktop-record");
        }}
      />
      <input
        hidden
        data-intro-video-document-input=""
        type="file"
        accept={DOCUMENT_ACCEPT}
        onChange={handleFileChange}
      />
    </div>
  );
}

function DesktopStep({
  detail,
  index,
  title,
}: {
  readonly detail: string;
  readonly index: number;
  readonly title: string;
}) {
  return (
    <li className="flex items-start gap-3 py-3">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-medium text-primary">
        {index}
      </span>
      <span className="min-w-0">
        <strong className="block text-sm font-medium text-foreground">
          {title}
        </strong>
        <small className="mt-0.5 block text-xs leading-5 text-muted-foreground">
          {detail}
        </small>
      </span>
    </li>
  );
}

function DesktopDownloadButton() {
  const { t } = useTranslation();
  const supportLoadable = useLoadable(desktopDownloadSupportStatus$);
  if (supportLoadable.state !== "hasData") {
    return (
      <Button type="button" variant="outline" className="mt-5" disabled>
        {t(($) => {
          return $.chat.introVideo.desktop.checkingCompatibility;
        })}
      </Button>
    );
  }
  if (supportLoadable.data === "unsupported-intel-mac") {
    return (
      <Button type="button" variant="outline" className="mt-5" disabled>
        <AlertTriangle size={15} />
        {t(($) => {
          return $.chat.introVideo.desktop.unsupportedIntelMac;
        })}
      </Button>
    );
  }
  return (
    <Button asChild className="mt-5">
      <a href={OKOU_DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer">
        <Download size={15} />
        {t(($) => {
          return $.chat.introVideo.desktop.download;
        })}
      </a>
    </Button>
  );
}

function DesktopRecordPage() {
  const { t } = useTranslation();
  const desktopProductName = useGet(computerUseProductName$);
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-8 md:grid-cols-[1.05fr_1fr] md:items-center">
      <div className="flex min-h-72 items-center justify-center rounded-2xl border border-border bg-gray-50 p-8">
        <div className="w-full max-w-sm overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex h-9 items-center gap-1.5 border-b border-border px-3">
            <span className="size-2 rounded-full bg-red-400" />
            <span className="size-2 rounded-full bg-amber-400" />
            <span className="size-2 rounded-full bg-emerald-400" />
          </div>
          <div className="grid min-h-48 place-items-center p-6 text-center">
            <div>
              <MonitorUp className="mx-auto size-9 text-primary" />
              <p className="mt-3 text-sm font-semibold text-foreground">
                {t(
                  ($) => {
                    return $.chat.introVideo.desktop.illustration;
                  },
                  { desktopProductName },
                )}
              </p>
            </div>
          </div>
        </div>
      </div>
      <div>
        <h3 className="text-xl font-semibold tracking-tight text-foreground">
          {t(
            ($) => {
              return $.chat.introVideo.desktop.heading;
            },
            { desktopProductName },
          )}
        </h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t(
            ($) => {
              return $.chat.introVideo.desktop.description;
            },
            { desktopProductName },
          )}
        </p>
        <ol className="mt-5 divide-y divide-border rounded-xl border border-border bg-card px-4">
          <DesktopStep
            index={1}
            title={t(
              ($) => {
                return $.chat.introVideo.desktop.installTitle;
              },
              { desktopProductName },
            )}
            detail={t(($) => {
              return $.chat.introVideo.desktop.installDetail;
            })}
          />
          <DesktopStep
            index={2}
            title={t(($) => {
              return $.chat.introVideo.desktop.recordTitle;
            })}
            detail={t(($) => {
              return $.chat.introVideo.desktop.recordDetail;
            })}
          />
          <DesktopStep
            index={3}
            title={t(($) => {
              return $.chat.introVideo.desktop.handoffTitle;
            })}
            detail={t(($) => {
              return $.chat.introVideo.desktop.handoffDetail;
            })}
          />
        </ol>
        <DesktopDownloadButton />
      </div>
    </div>
  );
}

function SourceReviewPage({
  source,
  persisted,
}: {
  readonly source: IntroVideoSource;
  readonly persisted: boolean;
}) {
  const { t } = useTranslation();
  const goToStep = useGoToStep();
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-8 md:grid-cols-[1.2fr_0.8fr] md:items-center">
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded-2xl border border-border bg-gray-50">
        {source.previewUrl ? (
          <video
            src={source.previewUrl}
            controls
            playsInline
            className="h-full w-full bg-gray-950 object-contain"
          />
        ) : (
          <div className="text-center">
            <span className="mx-auto grid size-16 place-items-center rounded-2xl bg-primary/10 text-primary">
              <FileText size={28} />
            </span>
            <div className="mx-auto mt-5 flex w-44 flex-col gap-2">
              <span className="h-2 rounded-full bg-gray-300" />
              <span className="h-2 w-4/5 rounded-full bg-gray-200" />
              <span className="h-2 w-3/5 rounded-full bg-gray-200" />
            </div>
          </div>
        )}
      </div>
      <div>
        <h3 className="text-xl font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.chat.introVideo.sourceReview.heading;
          })}
        </h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t(($) => {
            return $.chat.introVideo.sourceReview.help;
          })}
        </p>
        <div className="mt-5 flex items-center gap-3 rounded-xl border border-border bg-card p-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            {source.kind === "document" ? (
              <FileText size={18} />
            ) : (
              <Play size={18} fill="currentColor" />
            )}
          </span>
          <span className="min-w-0">
            <strong className="block truncate text-sm font-medium text-foreground">
              {source.name}
            </strong>
            <small className="mt-0.5 block text-xs text-muted-foreground">
              {formatBytes(source.size)}
              {source.durationSeconds === null
                ? ""
                : ` · ${formatDuration(source.durationSeconds)}`}
            </small>
          </span>
        </div>
        <dl className="mt-5 divide-y divide-border text-sm">
          <div className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">
              {t(($) => {
                return $.chat.introVideo.sourceReview.source;
              })}
            </dt>
            <dd className="font-medium text-foreground">
              {sourceKindLabel(t, source)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">
              {t(($) => {
                return $.chat.introVideo.sourceReview.format;
              })}
            </dt>
            <dd className="font-medium text-foreground">
              {sourceFormat(source)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">
              {t(($) => {
                return $.chat.introVideo.sourceReview.saved;
              })}
            </dt>
            <dd className="text-right font-medium text-foreground">
              {sourceSavedLabel(t, source, persisted)}
            </dd>
          </div>
        </dl>
        <Button
          type="button"
          variant="outline"
          className="mt-5"
          onClick={() => {
            goToStep("source");
          }}
        >
          <RefreshCw size={15} />
          {t(($) => {
            return $.chat.introVideo.sourceReview.replace;
          })}
        </Button>
      </div>
    </div>
  );
}

/**
 * Preview geometry for one placement, as percentages of the 16:9 output frame.
 *
 * These mirror the composition rule the generator follows: the deck is
 * letterboxed inside its rectangle and the presenter cutout is scaled
 * proportionally to a fixed share of the frame width, with its bottom edge on
 * the deck's bottom edge. The cutout is never cropped to a box or a circle, so
 * only its width is pinned here and the height follows the artwork. A very
 * tall cutout therefore runs past the top of the preview and is clipped there,
 * which is what the rendered video does too.
 */
function placementPreview(placement: IntroVideoPlacement): {
  readonly avatar: CSSProperties;
  readonly slide: CSSProperties;
} {
  switch (placement) {
    case "overlay": {
      return {
        avatar: { bottom: "6%", left: "75%", width: "14%" },
        slide: { height: "88%", left: "6%", top: "6%", width: "88%" },
      };
    }
    case "right": {
      return {
        avatar: { bottom: "11.5%", left: "83%", width: "14%" },
        slide: { height: "77%", left: "3%", top: "11.5%", width: "77%" },
      };
    }
    default: {
      return {
        avatar: { bottom: "11.5%", left: "3%", width: "14%" },
        slide: { height: "77%", left: "20%", top: "11.5%", width: "77%" },
      };
    }
  }
}

function PlacementOption({
  cutoutUrl,
  label,
  placement,
  selected,
  onSelect,
}: {
  readonly cutoutUrl: string | undefined;
  readonly label: string;
  readonly placement: IntroVideoPlacement;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const preview = placementPreview(placement);
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-intro-video-placement={placement}
      onClick={onSelect}
      className={cn(
        "group flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary" : "border-border",
      )}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-gray-50">
        <span
          aria-hidden="true"
          className="absolute rounded-[3px] border border-border bg-card"
          style={preview.slide}
        />
        {cutoutUrl ? (
          <img
            src={cutoutUrl}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            draggable={false}
            className="absolute"
            style={preview.avatar}
          />
        ) : null}
      </div>
      <div className="flex min-h-11 items-center justify-between gap-2 px-3 py-2.5">
        <p className="min-w-0 truncate text-sm font-semibold text-foreground">
          {label}
        </p>
        {selected ? (
          <span
            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            <Check size={13} />
          </span>
        ) : null}
      </div>
    </button>
  );
}

function PlacementSelector({
  cutoutUrl,
}: {
  readonly cutoutUrl: string | undefined;
}) {
  const { t } = useTranslation();
  const placement = useGet(introVideoWizardSignals.placement$);
  const setPlacement = useSet(introVideoWizardSignals.setPlacement$);
  const options: readonly {
    readonly label: string;
    readonly value: IntroVideoPlacement;
  }[] = [
    {
      label: t(($) => {
        return $.chat.introVideo.avatar.placementLeft;
      }),
      value: "left",
    },
    {
      label: t(($) => {
        return $.chat.introVideo.avatar.placementRight;
      }),
      value: "right",
    },
    {
      label: t(($) => {
        return $.chat.introVideo.avatar.placementOverlay;
      }),
      value: "overlay",
    },
  ];
  return (
    <section className="mb-5 rounded-xl border border-border bg-background p-4">
      <h4 className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.chat.introVideo.avatar.placementHeading;
        })}
      </h4>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {options.map((option) => {
          return (
            <PlacementOption
              key={option.value}
              cutoutUrl={cutoutUrl}
              label={option.label}
              placement={option.value}
              selected={placement === option.value}
              onSelect={() => {
                setPlacement(option.value);
              }}
            />
          );
        })}
      </div>
    </section>
  );
}

function AvatarPage({ composer }: { readonly composer: ComposerSignals }) {
  const { t } = useTranslation();
  const avatar = useGet(introVideoWizardSignals.avatar$);
  const source = useGet(introVideoWizardSignals.source$);
  const setAvatar = useSet(introVideoWizardSignals.setAvatar$);
  const selectAvatarForVoice = useSet(
    composer.template.selectAvatarTemplateForVoice$,
  );
  const clearAvatarForVoice = useSet(
    composer.template.clearAvatarTemplateVoiceSelection$,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-5">
        <h3 className="text-xl font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.chat.introVideo.avatar.heading;
          })}
        </h3>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t(($) => {
            return $.chat.introVideo.avatar.help;
          })}
        </p>
      </div>
      {avatar && source?.kind === "document" ? (
        <PlacementSelector cutoutUrl={avatar.coverUrl} />
      ) : null}
      <AvatarLibraryContent
        selectedAvatarId={avatar?.id}
        onSelect={(nextAvatar) => {
          setAvatar(nextAvatar);
          selectAvatarForVoice(nextAvatar);
        }}
        onClear={() => {
          setAvatar(null);
          clearAvatarForVoice();
        }}
      />
    </div>
  );
}

function VoiceUtilityCard({
  description,
  icon,
  selected,
  title,
  onSelect,
}: {
  readonly description: string;
  readonly icon: ReactNode;
  readonly selected: boolean;
  readonly title: string;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:border-foreground/20 hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary bg-primary/[0.04]" : "border-border",
      )}
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm font-semibold text-foreground">
          {title}
        </strong>
        <small className="mt-0.5 block text-xs leading-5 text-muted-foreground">
          {description}
        </small>
      </span>
      {selected ? (
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check size={13} />
        </span>
      ) : null}
    </button>
  );
}

function VoicePage({
  composer,
  source,
}: {
  readonly composer: ComposerSignals;
  readonly source: IntroVideoSource;
}) {
  const { t } = useTranslation();
  const voice = useGet(introVideoWizardSignals.voice$);
  const setVoice = useSet(introVideoWizardSignals.setVoice$);
  const originalAudioAvailable = source.kind === "recording";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.chat.introVideo.voice.heading;
            })}
          </h3>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t(($) => {
              return $.chat.introVideo.voice.help;
            })}
          </p>
        </div>
        <VoiceLibraryToolbar signals={composer} />
      </div>
      <div className="mb-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {originalAudioAvailable ? (
          <VoiceUtilityCard
            title={t(($) => {
              return $.chat.introVideo.voice.original;
            })}
            description={t(($) => {
              return $.chat.introVideo.voice.originalDescription;
            })}
            icon={<Volume2 size={18} />}
            selected={voice?.kind === "original"}
            onSelect={() => {
              setVoice({ kind: "original" });
            }}
          />
        ) : null}
        <VoiceUtilityCard
          title={t(($) => {
            return $.chat.introVideo.voice.none;
          })}
          description={t(($) => {
            return $.chat.introVideo.voice.noneDescription;
          })}
          icon={<VolumeX size={18} />}
          selected={voice?.kind === "none"}
          onSelect={() => {
            setVoice({ kind: "none" });
          }}
        />
      </div>
      <VoiceLibraryContent
        signals={composer}
        selectionActive={voice !== null}
        selectedVoiceId={voice?.kind === "catalog" ? voice.voice.id : undefined}
        onSelect={(selectedVoice) => {
          setVoice({ kind: "catalog", voice: selectedVoice });
        }}
      />
    </div>
  );
}

function ReviewItem({
  icon,
  label,
  value,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <strong className="mt-0.5 block truncate text-sm font-medium text-foreground">
          {value}
        </strong>
      </span>
    </div>
  );
}

function ReviewPage({ source }: { readonly source: IntroVideoSource }) {
  const { t } = useTranslation();
  const avatar = useGet(introVideoWizardSignals.avatar$);
  const voice = useGet(introVideoWizardSignals.voice$);
  const instructions = useGet(introVideoWizardSignals.instructions$);
  const setInstructions = useSet(introVideoWizardSignals.setInstructions$);
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h3 className="text-xl font-semibold tracking-tight text-foreground">
        {t(($) => {
          return $.chat.introVideo.review.heading;
        })}
      </h3>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        {t(($) => {
          return $.chat.introVideo.review.help;
        })}
      </p>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ReviewItem
          label={t(($) => {
            return $.chat.introVideo.review.source;
          })}
          value={`${source.name} · ${INTRO_VIDEO_ASPECT_RATIO_LABEL}`}
          icon={
            source.kind === "document" ? (
              <FileText size={18} />
            ) : (
              <Video size={18} />
            )
          }
        />
        <ReviewItem
          label={t(($) => {
            return $.chat.introVideo.review.avatar;
          })}
          value={
            avatar?.name ??
            t(($) => {
              return $.chat.introVideo.avatar.none;
            })
          }
          icon={<UserRound size={18} />}
        />
        <ReviewItem
          label={t(($) => {
            return $.chat.introVideo.review.voice;
          })}
          value={voiceLabel(t, voice)}
          icon={<Volume2 size={18} />}
        />
      </div>
      <label className="mt-6 block">
        <span className="mb-2 block text-sm font-medium text-foreground">
          {t(($) => {
            return $.chat.introVideo.review.instructions;
          })}
        </span>
        <Textarea
          value={instructions}
          rows={5}
          onChange={(event) => {
            setInstructions(event.currentTarget.value);
          }}
          className="resize-none bg-card leading-6"
        />
      </label>
    </div>
  );
}

function errorCopy(
  t: TFunction<"common">,
  error: IntroVideoWizardError,
): string {
  switch (error) {
    case "send-failed": {
      return t(($) => {
        return $.chat.introVideo.errors.sendFailed;
      });
    }
    case "upload-failed": {
      return t(($) => {
        return $.chat.introVideo.errors.uploadFailed;
      });
    }
  }
}

function primaryLabel(
  t: TFunction<"common">,
  step: IntroVideoWizardStep,
): string | null {
  switch (step) {
    case "source-review":
    case "avatar":
    case "voice": {
      return t(($) => {
        return $.chat.introVideo.footer.next;
      });
    }
    case "review": {
      return t(($) => {
        return $.chat.introVideo.footer.createInChat;
      });
    }
    default: {
      return null;
    }
  }
}

function previousWizardStep(
  step: IntroVideoWizardStep,
  source: IntroVideoSource | null,
): IntroVideoWizardStep | null {
  switch (step) {
    case "desktop-record":
    case "source-review": {
      return "source";
    }
    case "avatar": {
      return introVideoSourceStep(source);
    }
    case "voice": {
      return "avatar";
    }
    case "review": {
      return "voice";
    }
    default: {
      return null;
    }
  }
}

function nextWizardStep(
  step: IntroVideoWizardStep,
): IntroVideoWizardStep | null {
  switch (step) {
    case "source-review": {
      return "avatar";
    }
    case "avatar": {
      return "voice";
    }
    case "voice": {
      return "review";
    }
    default: {
      return null;
    }
  }
}

function WizardErrorBanner({
  error,
  source,
  onDownload,
}: {
  readonly error: IntroVideoWizardError;
  readonly source: IntroVideoSource | null;
  readonly onDownload: () => void;
}) {
  const { t } = useTranslation();
  // An uploaded source is already stored server-side, so there is no local copy
  // to rescue when the send fails.
  const canDownload =
    source?.origin === "local" &&
    (error === "upload-failed" || error === "send-failed");
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <span>{errorCopy(t, error)}</span>
      {canDownload ? (
        <Button type="button" size="xs" variant="outline" onClick={onDownload}>
          <Download size={14} />
          {t(($) => {
            return $.chat.introVideo.footer.download;
          })}
        </Button>
      ) : null}
    </div>
  );
}

function WizardFooter({
  busy,
  error,
  source,
  step,
  voice,
  composer,
}: {
  readonly busy: boolean;
  readonly error: IntroVideoWizardError | null;
  readonly source: IntroVideoSource | null;
  readonly step: IntroVideoWizardStep;
  readonly voice: IntroVideoVoiceSelection | null;
  readonly composer: ComposerSignals;
}) {
  const { t } = useTranslation();
  const rootSignal = useGet(rootSignal$);
  const goToStep = useGoToStep();
  const setStep = useSet(introVideoWizardSignals.setStep$);
  const submit = useSet(introVideoWizardSignals.submit$);
  const downloadSource = useSet(introVideoWizardSignals.downloadSource$);
  const label = primaryLabel(t, step);
  const goBack = () => {
    const previous = previousWizardStep(step, source);
    if (previous) {
      goToStep(previous);
    }
  };
  const activatePrimary = () => {
    if (step === "review") {
      detach(
        submit(composer, rootSignal),
        Reason.DomCallback,
        "create intro video chat thread",
      );
      return;
    }
    const next = nextWizardStep(step);
    if (next) {
      setStep(next);
    }
  };
  const canGoBack = !busy && step !== "source";
  const primaryDisabled =
    busy ||
    (step === "voice" && voice === null) ||
    (step === "review" && (!source || voice === null));
  return (
    <footer className="shrink-0 border-t border-border bg-card px-5 py-3.5 sm:px-6">
      {error ? (
        <WizardErrorBanner
          error={error}
          source={source}
          onDownload={downloadSource}
        />
      ) : null}
      <div className="flex items-center justify-end gap-4">
        <div className="flex shrink-0 items-center gap-2">
          {canGoBack ? (
            <Button type="button" variant="ghost" onClick={goBack}>
              <ArrowLeft size={15} />
              {t(($) => {
                return $.chat.introVideo.footer.back;
              })}
            </Button>
          ) : null}
          {label ? (
            <Button
              type="button"
              disabled={primaryDisabled}
              onClick={activatePrimary}
            >
              {busy ? <RefreshCw className="animate-spin" size={15} /> : null}
              {label}
            </Button>
          ) : null}
        </div>
      </div>
    </footer>
  );
}

function WizardContent({
  composer,
  source,
  sourcePersisted,
  step,
}: {
  readonly composer: ComposerSignals;
  readonly source: IntroVideoSource | null;
  readonly sourcePersisted: boolean;
  readonly step: IntroVideoWizardStep;
}) {
  switch (step) {
    case "source": {
      return <SourcePage />;
    }
    case "desktop-record": {
      return <DesktopRecordPage />;
    }
    case "source-review": {
      return source ? (
        <SourceReviewPage source={source} persisted={sourcePersisted} />
      ) : (
        <SourcePage />
      );
    }
    case "avatar": {
      return <AvatarPage composer={composer} />;
    }
    case "voice": {
      return source ? (
        <VoicePage composer={composer} source={source} />
      ) : (
        <SourcePage />
      );
    }
    case "review": {
      return source ? <ReviewPage source={source} /> : <SourcePage />;
    }
  }
}

function WizardHeader({
  busy,
  source,
  step,
}: {
  readonly busy: boolean;
  readonly source: IntroVideoSource | null;
  readonly step: IntroVideoWizardStep;
}) {
  const { t } = useTranslation();
  const goToStep = useGoToStep();
  const activeStage = wizardStage(step);
  const stepLabels = [
    t(($) => {
      return $.chat.introVideo.steps.source;
    }),
    t(($) => {
      return $.chat.introVideo.steps.avatar;
    }),
    t(($) => {
      return $.chat.introVideo.steps.voice;
    }),
    t(($) => {
      return $.chat.introVideo.steps.review;
    }),
  ];
  return (
    <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-14 text-left sm:px-6">
      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Clapperboard size={18} />
          </span>
          <DialogTitle className="truncate text-base font-semibold">
            {t(($) => {
              return $.chat.introVideo.title;
            })}
          </DialogTitle>
        </div>
        <nav
          aria-label={t(($) => {
            return $.chat.introVideo.steps.label;
          })}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {stepLabels.map((label, index) => {
            return (
              <WizardStepButton
                key={label}
                index={index}
                label={label}
                active={index === activeStage}
                completed={index < activeStage}
                disabled={busy || (index > 0 && !source)}
                onClick={() => {
                  goToStep(stepForStage(index, source));
                }}
              />
            );
          })}
        </nav>
      </div>
      <DialogDescription
        id="intro-video-wizard-description"
        className="sr-only"
      >
        {t(($) => {
          return $.chat.introVideo.description;
        })}
      </DialogDescription>
    </DialogHeader>
  );
}

export function IntroVideoWizard({
  composer,
}: {
  readonly composer: ComposerSignals;
}) {
  const open = useGet(introVideoWizardSignals.open$);
  const step = useGet(introVideoWizardSignals.step$);
  const source = useGet(introVideoWizardSignals.source$);
  const sourcePersisted = useGet(introVideoWizardSignals.sourcePersisted$);
  const voice = useGet(introVideoWizardSignals.voice$);
  const busy = useGet(introVideoWizardSignals.busy$);
  const error = useGet(introVideoWizardSignals.error$);
  const closeWizard = useSet(introVideoWizardSignals.closeWizard$);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeWizard();
        }
      }}
    >
      <DialogContent
        aria-describedby="intro-video-wizard-description"
        className="zero-app flex h-[min(88vh,820px)] w-[calc(100vw-1.5rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 [&>button]:right-4 [&>button]:top-4"
      >
        <WizardHeader busy={busy} source={source} step={step} />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background px-5 py-6 sm:px-6">
          <WizardContent
            composer={composer}
            source={source}
            sourcePersisted={sourcePersisted}
            step={step}
          />
        </div>
        <WizardFooter
          busy={busy}
          error={error}
          source={source}
          step={step}
          voice={voice}
          composer={composer}
        />
      </DialogContent>
    </Dialog>
  );
}
