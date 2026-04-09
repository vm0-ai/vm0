import { useGet, useSet } from "ccstate-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  cn,
} from "@vm0/ui";
import {
  IconWand,
  IconChevronLeft,
  IconChevronRight,
  IconDice,
  IconCheck,
} from "@tabler/icons-react";
import type { AvatarSvgConfig } from "./avatar-svg-utils.ts";
import { AvatarSvgPreview } from "./avatar-svg-preview.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import {
  type Step,
  AVATAR_MAKER_STEPS,
  INTENSITY_LABELS,
  avatarMakerOpen$,
  avatarMakerConfig$,
  avatarMakerStep$,
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
} from "../../signals/zero-page/settings/avatar-maker.ts";

function getSparkleColors() {
  return ["#ed4e01", "#E0B376", "#E26C9E", "#45A7A8", "#E0BB3C", "#FF990A"];
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
      color: colors[Math.floor(rand() * colors.length)] ?? "#ed4e01",
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

function StepOptions({
  step,
  config,
  justPicked,
  selectOption,
}: {
  step: Step;
  config: AvatarSvgConfig;
  justPicked: string | null;
  selectOption: (field: Step, value: number | string) => void;
}) {
  if (step === "intensity") {
    return (["d", "m", "h"] as const).map((val, i) => {
      const isPicked = justPicked === `intensity-${val}`;
      const preview = { ...config, intensity: val };
      return (
        <button
          key={val}
          type="button"
          className={cn(
            "flex flex-col items-center gap-1 rounded-full transition-all hover:scale-110",
            isPicked && "scale-110 ring-2 ring-[#ed4e01] ring-offset-2",
          )}
          style={{
            animation: `avatar-option-appear 0.2s ease-out ${i * 0.05}s both`,
          }}
          onClick={() => {
            return selectOption("intensity", val);
          }}
        >
          <AvatarSvgPreview config={preview} size={56} />
          <span className="text-[10px] text-muted-foreground">
            {INTENSITY_LABELS[val]}
          </span>
        </button>
      );
    });
  }

  if (step === "skin") {
    return Array.from({ length: 5 }, (_, i) => {
      const val = i;
      const isPicked = justPicked === `skin-${val}`;
      const preview = { ...config, skin: val };
      return (
        <button
          key={val}
          type="button"
          className={cn(
            "rounded-full transition-all hover:scale-110",
            isPicked && "scale-110 ring-2 ring-[#ed4e01] ring-offset-2",
          )}
          style={{
            animation: `avatar-option-appear 0.2s ease-out ${i * 0.05}s both`,
          }}
          onClick={() => {
            return selectOption("skin", val);
          }}
        >
          <AvatarSvgPreview config={preview} size={56} />
        </button>
      );
    });
  }

  return Array.from({ length: 5 }, (_, i) => {
    const val = i + 1;
    const isPicked = justPicked === `${step}-${val}`;
    const preview = { ...config, [step]: val };
    return (
      <button
        key={val}
        type="button"
        className={cn(
          "rounded-full transition-all hover:scale-110",
          isPicked && "scale-110 ring-2 ring-[#ed4e01] ring-offset-2",
        )}
        style={{
          animation: `avatar-option-appear 0.2s ease-out ${i * 0.05}s both`,
        }}
        onClick={() => {
          return selectOption(step, val);
        }}
      >
        <AvatarSvgPreview config={preview as AvatarSvgConfig} size={56} />
      </button>
    );
  });
}

function AvatarPreviewWithShuffle() {
  const config = useGet(avatarMakerConfig$);
  const justPicked = useGet(avatarMakerJustPicked$);
  const showSparkles = useGet(avatarMakerShowSparkles$);
  const shuffling = useGet(avatarMakerShuffling$);
  const shuffle = useSet(shuffleAvatar$);

  return (
    <div
      className={cn(
        "group relative overflow-visible transition-transform duration-200",
        justPicked || shuffling ? "scale-110" : "scale-100",
      )}
    >
      <AvatarSvgPreview config={config} size={96} />
      <Sparkles active={showSparkles} />
      <button
        type="button"
        className={cn(
          "absolute -right-1 -bottom-1 flex h-7 w-7 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm border border-border transition-opacity hover:text-foreground",
          shuffling ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        onClick={shuffle}
        aria-label="Randomize avatar"
      >
        <IconDice
          size={14}
          stroke={1.5}
          style={
            shuffling
              ? { animation: "avatar-dice-spin 0.6s ease-out" }
              : undefined
          }
        />
      </button>
    </div>
  );
}

function StepNavigator() {
  const step = useGet(avatarMakerStep$);
  const stepIdx = useGet(avatarMakerStepIdx$);
  const goBack = useSet(goBackStep$);
  const goForward = useSet(goForwardStep$);

  return (
    <>
      <div className="flex items-center gap-1">
        {AVATAR_MAKER_STEPS.map((s, i) => {
          return (
            <div
              key={s.key}
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
        <button
          type="button"
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground",
            stepIdx === 0 && "invisible",
          )}
          onClick={goBack}
          aria-label="Previous step"
        >
          <IconChevronLeft size={14} />
        </button>
        <p
          className="min-w-[3rem] text-center text-xs font-semibold text-foreground"
          key={step}
          style={{ animation: "avatar-option-appear 0.15s ease-out" }}
        >
          {AVATAR_MAKER_STEPS[stepIdx]?.label}
        </p>
        <button
          type="button"
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground",
            stepIdx === AVATAR_MAKER_STEPS.length - 1 && "invisible",
          )}
          onClick={goForward}
          aria-label="Next step"
        >
          <IconChevronRight size={14} />
        </button>
      </div>
    </>
  );
}

function AvatarMakerDialogBody({
  onConfirm,
}: {
  onConfirm: (config: AvatarSvgConfig) => Promise<void>;
}) {
  const config = useGet(avatarMakerConfig$);
  const step = useGet(avatarMakerStep$);
  const justPicked = useGet(avatarMakerJustPicked$);
  const saving = useGet(avatarMakerSaving$);

  const selectOption = useSet(selectAvatarOption$);
  const closeMaker = useSet(closeAvatarMaker$);
  const setSaving = useSet(setAvatarMakerSaving$);

  const handleConfirm = () => {
    setSaving(true);
    detach(
      onConfirm(config).then(
        () => {
          setSaving(false);
          closeMaker();
        },
        () => {
          setSaving(false);
        },
      ),
      Reason.DomCallback,
    );
  };

  return (
    <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Create Avatar</DialogTitle>
      </DialogHeader>

      <div className="flex flex-col items-center gap-4 py-2">
        <AvatarPreviewWithShuffle />
        <StepNavigator />
        <div className="flex gap-3 flex-wrap justify-center">
          <StepOptions
            step={step}
            config={config}
            justPicked={justPicked}
            selectOption={selectOption}
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={closeMaker} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleConfirm} disabled={saving}>
          <IconCheck size={16} className="mr-1" />
          {saving ? "Saving…" : "Apply"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

interface AvatarMakerProps {
  onConfirm: (config: AvatarSvgConfig) => Promise<void>;
  /** Custom trigger element. Receives `openMaker` as `onClick`. When omitted, the default wand button is rendered. */
  trigger?: (openMaker: () => void) => React.ReactNode;
}

export function AvatarMaker({ onConfirm, trigger }: AvatarMakerProps) {
  const open = useGet(avatarMakerOpen$);
  const openMaker = useSet(openAvatarMaker$);
  const closeMaker = useSet(closeAvatarMaker$);

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
        <button
          type="button"
          onClick={() => {
            return openMaker();
          }}
          className="h-12 w-12 shrink-0 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="Create custom avatar"
        >
          <IconWand size={16} stroke={1.5} />
        </button>
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
