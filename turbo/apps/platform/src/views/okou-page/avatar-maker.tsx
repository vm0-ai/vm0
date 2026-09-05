import { useGet, useSet } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import { Wand, ChevronLeft, ChevronRight, Dices } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  AVATAR_COMPOSER_EXPRESSIONS,
  AVATAR_COMPOSER_FACE_SHAPES,
  AVATAR_COMPOSER_HAIR_COLORS,
  AVATAR_COMPOSER_HAIR_STYLES,
  AVATAR_COMPOSER_SKIN_TONES,
  AVATAR_COMPOSER_SWEATER_COLORS,
  isAvatarComposerCombinationCompatible,
  updateAvatarComposerConfig,
  type AvatarComposerSelection,
} from "@okouai/core/agent-avatar";
import {
  isLegacyAvatarSvgConfig,
  type AvatarSvgConfig,
  type LegacyAvatarSvgConfig,
  type ResolvedAvatarSvgConfig,
} from "./avatar-svg-utils.ts";
import { AvatarSvgPreview } from "./avatar-svg-preview.tsx";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
} from "../../signals/utils.ts";
import {
  type AvatarMakerSelection,
  type ComposerStep,
  type LegacyStep,
  type Step,
  avatarMakerOpen$,
  avatarMakerConfig$,
  avatarMakerEditing$,
  avatarMakerStep$,
  avatarMakerSteps$,
  avatarMakerStepIdx$,
  avatarMakerJustPicked$,
  avatarMakerShowSparkles$,
  avatarMakerShuffling$,
  openAvatarMaker$,
  selectAvatarOption$,
  shuffleAvatar$,
  goBackStep$,
  goForwardStep$,
  closeAvatarMaker$,
  avatarMakerSaving$,
  setAvatarMakerSaving$,
} from "../../signals/okou-page/settings/avatar-maker.ts";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";

function getSparkleColors() {
  return ["#ffa500", "#E0B376", "#E26C9E", "#45A7A8", "#E0BB3C", "#FF990A"];
}

function generateParticles() {
  let seed = 77;
  const rand = () => {
    seed = (seed * 16_807) % 2_147_483_647;
    return (seed - 1) / 2_147_483_646;
  };

  const colors = getSparkleColors();
  return Array.from({ length: 20 }, () => {
    const xDir = (rand() - 0.5) * 140;
    const yDir = -(30 + rand() * 50);
    return {
      x: xDir,
      y: yDir,
      size: 3 + rand() * 5,
      color: colors[Math.floor(rand() * colors.length)] ?? "#ffa500",
      delay: rand() * 0.15,
    };
  });
}

function getSparkleParticles() {
  return generateParticles();
}

function Sparkles({ active }: { active: boolean }) {
  if (!active) {
    return null;
  }

  const particles = getSparkleParticles();
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {particles.map((p) => {
        const key = `${p.x.toFixed(2)}_${p.y.toFixed(2)}_${p.size.toFixed(2)}`;
        return (
          <div
            key={key}
            className="absolute rounded-full"
            style={
              {
                width: p.size,
                height: p.size,
                backgroundColor: p.color,
                left: "50%",
                top: "10%",
                animation: "avatar-firework 0.6s ease-out forwards",
                animationDelay: `${p.delay}s`,
                transform: "translate(-50%, -50%) scale(1)",
                "--fx": `${p.x}px`,
                "--fy": `${p.y}px`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

type ComposerAvatarMakerSelection = {
  readonly mode: "composer";
} & AvatarComposerSelection;

function avatarMakerSelections(
  step: ComposerStep,
): readonly ComposerAvatarMakerSelection[] {
  switch (step) {
    case "face": {
      return AVATAR_COMPOSER_FACE_SHAPES.map((value) => {
        return { mode: "composer", field: "face", value };
      });
    }
    case "hair": {
      return AVATAR_COMPOSER_HAIR_STYLES.map((value) => {
        return { mode: "composer", field: "hair", value };
      });
    }
    case "expression": {
      return AVATAR_COMPOSER_EXPRESSIONS.map((value) => {
        return { mode: "composer", field: "expression", value };
      });
    }
    case "skin": {
      return AVATAR_COMPOSER_SKIN_TONES.map((value) => {
        return { mode: "composer", field: "skin", value };
      });
    }
    case "hairColor": {
      return AVATAR_COMPOSER_HAIR_COLORS.map((value) => {
        return { mode: "composer", field: "hairColor", value };
      });
    }
    case "sweater": {
      return AVATAR_COMPOSER_SWEATER_COLORS.map((value) => {
        return { mode: "composer", field: "sweater", value };
      });
    }
  }
}

function avatarOptionLabel(value: string): string {
  const label = value.replaceAll("-", " ");
  return `${label.slice(0, 1).toLocaleUpperCase()}${label.slice(1)}`;
}

function ComposerStepOptions({
  step,
  config,
  justPicked,
  selectOption,
}: {
  step: ComposerStep;
  config: AvatarSvgConfig;
  justPicked: string | null;
  selectOption: (selection: AvatarMakerSelection) => void;
}) {
  return avatarMakerSelections(step).map((selection, index) => {
    const isPicked = justPicked === `${selection.field}-${selection.value}`;
    const disabled =
      selection.field === "hair" &&
      !isAvatarComposerCombinationCompatible(
        selection.value,
        config.expression,
      );
    const preview = updateAvatarComposerConfig(config, selection);
    return (
      <button
        key={selection.value}
        type="button"
        disabled={disabled}
        className={cn(
          "rounded-full transition-all hover:scale-110 disabled:opacity-30 disabled:hover:scale-100",
          isPicked && "scale-110 ring-2 ring-[#ed4e01] ring-offset-2",
        )}
        style={{
          animation: `avatar-option-appear 0.2s ease-out ${index * 0.05}s both`,
        }}
        onClick={() => {
          return selectOption(selection);
        }}
        aria-label={avatarOptionLabel(selection.value)}
      >
        <AvatarSvgPreview config={preview} size={56} />
      </button>
    );
  });
}

function legacyStepLabel(step: LegacyStep, t: TFunction<"agents">): string {
  switch (step) {
    case "rotation": {
      return t(($) => {
        return $.avatar.steps.angle;
      });
    }
    case "skin": {
      return t(($) => {
        return $.avatar.steps.skin;
      });
    }
    case "hairStyle": {
      return t(($) => {
        return $.avatar.steps.hair;
      });
    }
    case "hairColor": {
      return t(($) => {
        return $.avatar.steps.color;
      });
    }
    case "expression": {
      return t(($) => {
        return $.avatar.steps.face;
      });
    }
    case "intensity": {
      return t(($) => {
        return $.avatar.steps.mood;
      });
    }
  }
}

function LegacyStepOptions({
  step,
  config,
  justPicked,
  selectOption,
}: {
  step: LegacyStep;
  config: LegacyAvatarSvgConfig;
  justPicked: string | null;
  selectOption: (selection: AvatarMakerSelection) => void;
}) {
  const { t } = useTranslation("agents");
  if (step === "intensity") {
    const labels = {
      d: t(($) => {
        return $.avatar.intensity.chill;
      }),
      m: t(($) => {
        return $.avatar.intensity.normal;
      }),
      h: t(($) => {
        return $.avatar.intensity.hyped;
      }),
    };
    return (["d", "m", "h"] as const).map((value, index) => {
      const preview = { ...config, intensity: value };
      return (
        <button
          key={value}
          type="button"
          className={cn(
            "flex flex-col items-center gap-1 rounded-full transition-all hover:scale-110",
            justPicked === `intensity-${value}` &&
              "scale-110 ring-2 ring-primary ring-offset-2",
          )}
          style={{
            animation: `avatar-option-appear 0.2s ease-out ${index * 0.05}s both`,
          }}
          onClick={() => {
            selectOption({ mode: "legacy", field: "intensity", value });
          }}
          aria-label={labels[value]}
        >
          <AvatarSvgPreview config={preview} size={56} />
          <span className="text-[10px] text-muted-foreground">
            {labels[value]}
          </span>
        </button>
      );
    });
  }

  const start = step === "skin" ? 0 : 1;
  return Array.from({ length: 5 }, (_, index) => {
    const value = index + start;
    const preview: LegacyAvatarSvgConfig = { ...config, [step]: value };
    return (
      <button
        key={value}
        type="button"
        className={cn(
          "rounded-full transition-all hover:scale-110",
          justPicked === `${step}-${value}` &&
            "scale-110 ring-2 ring-primary ring-offset-2",
        )}
        style={{
          animation: `avatar-option-appear 0.2s ease-out ${index * 0.05}s both`,
        }}
        onClick={() => {
          selectOption({ mode: "legacy", field: step, value });
        }}
        aria-label={`${legacyStepLabel(step, t)} ${index + 1}`}
      >
        <AvatarSvgPreview config={preview} size={56} />
      </button>
    );
  });
}

function isComposerStep(step: Step): step is ComposerStep {
  return (
    step === "face" ||
    step === "hair" ||
    step === "expression" ||
    step === "skin" ||
    step === "hairColor" ||
    step === "sweater"
  );
}

function isLegacyStep(step: Step): step is LegacyStep {
  return step !== "face" && step !== "hair" && step !== "sweater";
}

function StepOptions({
  step,
  config,
  justPicked,
  selectOption,
}: {
  step: Step;
  config: ResolvedAvatarSvgConfig;
  justPicked: string | null;
  selectOption: (selection: AvatarMakerSelection) => void;
}) {
  if (isLegacyAvatarSvgConfig(config)) {
    return isLegacyStep(step) ? (
      <LegacyStepOptions
        step={step}
        config={config}
        justPicked={justPicked}
        selectOption={selectOption}
      />
    ) : null;
  }
  return isComposerStep(step) ? (
    <ComposerStepOptions
      step={step}
      config={config}
      justPicked={justPicked}
      selectOption={selectOption}
    />
  ) : null;
}

function AvatarPreviewWithShuffle() {
  const { t } = useTranslation("agents");
  const config = useGet(avatarMakerConfig$);
  const justPicked = useGet(avatarMakerJustPicked$);
  const showSparkles = useGet(avatarMakerShowSparkles$);
  const shuffling = useGet(avatarMakerShuffling$);
  const shuffle = useSet(shuffleAvatar$);
  const pageSignal = useGet(pageSignal$);

  return (
    <div
      className={cn(
        "group relative overflow-visible transition-transform duration-200",
        justPicked || shuffling ? "scale-110" : "scale-100",
      )}
    >
      <AvatarSvgPreview config={config} size={96} />
      <Sparkles active={showSparkles} />
      <TooltipProvider delayDuration={800} skipDelayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              className="absolute -right-1 -bottom-1 flex h-7 w-7 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm border border-border hover:text-foreground transition-colors"
              onClick={() => {
                detach(shuffle(pageSignal), Reason.DomCallback);
              }}
              aria-label={t(($) => {
                return $.avatar.randomize;
              })}
            >
              <Dices
                size={14}
                style={
                  shuffling
                    ? { animation: "avatar-dice-spin 0.6s ease-out" }
                    : undefined
                }
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">
              {t(($) => {
                return $.avatar.shuffleHint;
              })}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function StepNavigator() {
  const { t } = useTranslation("agents");
  const config = useGet(avatarMakerConfig$);
  const step = useGet(avatarMakerStep$);
  const steps = useGet(avatarMakerSteps$);
  const stepIdx = useGet(avatarMakerStepIdx$);
  const goBack = useSet(goBackStep$);
  const goForward = useSet(goForwardStep$);
  const legacy = isLegacyAvatarSvgConfig(config);
  const stepLabels: Record<Step, string> = {
    face: t(($) => {
      return $.avatar.steps.face;
    }),
    hair: t(($) => {
      return $.avatar.steps.hair;
    }),
    expression: t(($) => {
      return legacy ? $.avatar.steps.face : $.avatar.steps.mood;
    }),
    skin: t(($) => {
      return $.avatar.steps.skin;
    }),
    hairColor: t(($) => {
      return $.avatar.steps.color;
    }),
    sweater: t(($) => {
      return $.avatar.steps.sweater;
    }),
    rotation: t(($) => {
      return $.avatar.steps.angle;
    }),
    hairStyle: t(($) => {
      return $.avatar.steps.hair;
    }),
    intensity: t(($) => {
      return $.avatar.steps.mood;
    }),
  };

  return (
    <>
      <div className="flex items-center gap-1">
        {steps.map((stepKey, i) => {
          return (
            <div
              key={stepKey}
              className={cn(
                "h-1.5 rounded-full transition-all duration-300",
                i === stepIdx
                  ? "w-5 bg-primary"
                  : i < stepIdx
                    ? "w-1.5 bg-primary/40"
                    : "w-1.5 bg-muted-foreground/20",
              )}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <IconTooltipButton
          type="button"
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground",
            stepIdx === 0 && "invisible",
          )}
          onClick={goBack}
          aria-label={t(($) => {
            return $.avatar.previousStep;
          })}
        >
          <ChevronLeft size={14} />
        </IconTooltipButton>
        <p
          className="min-w-[3rem] text-center text-xs font-semibold text-foreground"
          key={step}
          style={{ animation: "avatar-option-appear 0.15s ease-out" }}
        >
          {stepLabels[step]}
        </p>
        <IconTooltipButton
          type="button"
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground",
            stepIdx === steps.length - 1 && "invisible",
          )}
          onClick={goForward}
          aria-label={t(($) => {
            return $.avatar.nextStep;
          })}
        >
          <ChevronRight size={14} />
        </IconTooltipButton>
      </div>
    </>
  );
}

function AvatarMakerDialogBody({
  onConfirm,
}: {
  onConfirm: (config: ResolvedAvatarSvgConfig) => Promise<void>;
}) {
  const { t } = useTranslation("agents");
  const config = useGet(avatarMakerConfig$);
  const editing = useGet(avatarMakerEditing$);
  const step = useGet(avatarMakerStep$);
  const justPicked = useGet(avatarMakerJustPicked$);
  const saving = useGet(avatarMakerSaving$);

  const selectOption = useSet(selectAvatarOption$);
  const pageSignal = useGet(pageSignal$);
  const closeMaker = useSet(closeAvatarMaker$);
  const setSaving = useSet(setAvatarMakerSaving$);

  const title = editing
    ? t(($) => {
        return $.avatar.editTitle;
      })
    : t(($) => {
        return $.avatar.title;
      });
  const description = editing
    ? t(($) => {
        return $.avatar.editDescription;
      })
    : t(($) => {
        return $.avatar.description;
      });

  const handleConfirm = onDomEventFn(async () => {
    setSaving(true);
    await bestEffort(
      (async () => {
        await onConfirm(config);
        closeMaker();
      })(),
    );
    setSaving(false);
  });

  return (
    <DialogContent
      closeLabel={t(($) => {
        return $.actions.close;
      })}
      className="w-[calc(100vw-2rem)] sm:max-w-lg p-0 gap-0 overflow-hidden"
    >
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {t(($) => {
            return $.avatar.accessibilityDescription;
          })}
        </DialogDescription>
      </DialogHeader>

      {/* Preview section */}
      <div className="flex flex-col items-center gap-3 px-6 pt-8 pb-5 bg-muted/30">
        <AvatarPreviewWithShuffle />
      </div>

      {/* Controls section */}
      <div className="flex flex-col items-center gap-4 px-6 py-5">
        <div className="text-center">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        <StepNavigator />
        <div className="h-48 w-full overflow-y-auto px-1 py-1">
          <div className="flex min-h-full flex-wrap content-center justify-center gap-3">
            <StepOptions
              step={step}
              config={config}
              justPicked={justPicked}
              selectOption={(selection) => {
                detach(selectOption(selection, pageSignal), Reason.DomCallback);
              }}
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex justify-center gap-3 px-6 pt-6 pb-6">
        <Button variant="outline" onClick={closeMaker} disabled={saving}>
          {t(($) => {
            return $.actions.cancel;
          })}
        </Button>
        <Button onClick={handleConfirm} disabled={saving}>
          {saving
            ? t(($) => {
                return $.actions.saving;
              })
            : t(($) => {
                return $.avatar.use;
              })}
        </Button>
      </div>
    </DialogContent>
  );
}

interface AvatarMakerProps {
  onConfirm: (config: ResolvedAvatarSvgConfig) => Promise<void>;
  /** Avatar to load for editing. Omit to start from a random avatar. */
  avatarUrl?: string | null;
  /** Custom trigger element. Receives `openMaker` as `onClick`. When omitted, the default wand button is rendered. */
  trigger?: (openMaker: () => void) => React.ReactNode;
}

export function AvatarMaker({
  onConfirm,
  avatarUrl = null,
  trigger,
}: AvatarMakerProps) {
  const { t } = useTranslation("agents");
  const open = useGet(avatarMakerOpen$);
  const setOpenMaker = useSet(openAvatarMaker$);
  const closeMaker = useSet(closeAvatarMaker$);
  const openMaker = () => {
    setOpenMaker(avatarUrl);
  };

  return (
    <>
      <style>{`
        @keyframes avatar-option-appear {
          from { opacity: 0; transform: translateY(8px) scale(0.9); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes avatar-dice-spin {
          0% { transform: rotate(0deg) scale(1); }
          30% { transform: rotate(180deg) scale(1.3); }
          100% { transform: rotate(360deg) scale(1); }
        }
        @keyframes avatar-firework {
          0% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          70% { opacity: 0.8; }
          100% { opacity: 0; transform: translate(calc(-50% + var(--fx)), calc(-50% + var(--fy))) scale(0.3); }
        }
      `}</style>
      {trigger ? (
        trigger(openMaker)
      ) : (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={openMaker}
                className="h-12 w-12 shrink-0 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label={t(($) => {
                  return $.avatar.create;
                })}
              >
                <Wand size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">
                {t(($) => {
                  return $.avatar.create;
                })}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            closeMaker();
          }
        }}
      >
        <AvatarMakerDialogBody onConfirm={onConfirm} />
      </Dialog>
    </>
  );
}
