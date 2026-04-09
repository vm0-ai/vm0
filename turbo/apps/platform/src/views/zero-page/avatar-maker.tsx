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
import { IconWand, IconChevronLeft, IconCheck } from "@tabler/icons-react";
import type { AvatarSvgConfig } from "./avatar-svg-utils.ts";
import { AvatarSvgPreview } from "./avatar-svg-preview.tsx";
import {
  AVATAR_MAKER_STEPS,
  INTENSITY_LABELS,
  avatarMakerOpen$,
  avatarMakerConfig$,
  avatarMakerStep$,
  avatarMakerStepIdx$,
  avatarMakerJustPicked$,
  openAvatarMaker$,
  selectAvatarOption$,
  goBackStep$,
  closeAvatarMaker$,
} from "../../signals/zero-page/settings/avatar-maker.ts";

interface AvatarMakerProps {
  initialConfig: AvatarSvgConfig | null;
  onConfirm: (config: AvatarSvgConfig) => void;
}

export function AvatarMaker({ initialConfig, onConfirm }: AvatarMakerProps) {
  const open = useGet(avatarMakerOpen$);
  const config = useGet(avatarMakerConfig$);
  const step = useGet(avatarMakerStep$);
  const stepIdx = useGet(avatarMakerStepIdx$);
  const justPicked = useGet(avatarMakerJustPicked$);

  const openMaker = useSet(openAvatarMaker$);
  const selectOption = useSet(selectAvatarOption$);
  const goBack = useSet(goBackStep$);
  const closeMaker = useSet(closeAvatarMaker$);

  const handleConfirm = () => {
    onConfirm(config);
    closeMaker();
  };

  function renderOptions() {
    if (step === "intensity") {
      return (["d", "m", "h"] as const).map((val) => {
        const isPicked = justPicked === `intensity-${val}`;
        const preview = { ...config, intensity: val };
        const isActive = config.intensity === val;
        return (
          <button
            key={val}
            type="button"
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-full transition-all duration-150 hover:scale-105",
              isPicked && "scale-105",
            )}
            onClick={() => {
              return selectOption("intensity", val);
            }}
          >
            <div
              className={cn(
                "rounded-full border-2 transition-all duration-150",
                isActive
                  ? "border-primary ring-2 ring-primary/20"
                  : "border-transparent",
              )}
            >
              <AvatarSvgPreview config={preview} size={56} />
            </div>
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
        const isActive = config.skin === val;
        return (
          <button
            key={val}
            type="button"
            className={cn(
              "rounded-full transition-all duration-150 hover:scale-105",
              isPicked && "scale-105",
            )}
            onClick={() => {
              return selectOption("skin", val);
            }}
          >
            <div
              className={cn(
                "rounded-full border-2 transition-all duration-150",
                isActive
                  ? "border-primary ring-2 ring-primary/20"
                  : "border-transparent",
              )}
            >
              <AvatarSvgPreview config={preview} size={56} />
            </div>
          </button>
        );
      });
    }

    const max = step === "hairColor" ? 4 : 5;
    return Array.from({ length: max }, (_, i) => {
      const val = i + 1;
      const isPicked = justPicked === `${step}-${val}`;
      const preview = { ...config, [step]: val };
      const isActive = config[step] === val;
      return (
        <button
          key={val}
          type="button"
          className={cn(
            "rounded-full transition-all duration-150 hover:scale-105",
            isPicked && "scale-105",
          )}
          onClick={() => {
            return selectOption(step, val);
          }}
        >
          <div
            className={cn(
              "rounded-full border-2 transition-all duration-150",
              isActive
                ? "border-primary ring-2 ring-primary/20"
                : "border-transparent",
            )}
          >
            <AvatarSvgPreview config={preview as AvatarSvgConfig} size={56} />
          </div>
        </button>
      );
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          return openMaker(initialConfig);
        }}
        className="h-12 w-12 shrink-0 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="Create custom avatar"
      >
        <IconWand size={16} stroke={1.5} />
      </button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            closeMaker();
          }
        }}
      >
        <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Avatar</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col items-center gap-4 py-2">
            <div
              className={cn(
                "transition-transform duration-200",
                justPicked ? "scale-110" : "scale-100",
              )}
            >
              <AvatarSvgPreview config={config} size={96} />
            </div>

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

            <p className="text-xs font-semibold text-foreground">
              {AVATAR_MAKER_STEPS[stepIdx]?.label}
            </p>

            <div className="flex gap-3 flex-wrap justify-center">
              {renderOptions()}
            </div>

            {stepIdx > 0 && (
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={goBack}
              >
                <IconChevronLeft size={14} />
                Back
              </button>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeMaker}>
              Cancel
            </Button>
            <Button onClick={handleConfirm}>
              <IconCheck size={16} className="mr-1" />
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
