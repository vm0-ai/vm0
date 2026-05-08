"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  IconChevronLeft,
  IconChevronRight,
  IconDice,
} from "@tabler/icons-react";

type Step =
  | "rotation"
  | "skin"
  | "hairStyle"
  | "hairColor"
  | "expression"
  | "intensity";

type Intensity = "d" | "m" | "h";

interface AvatarSvgConfig {
  rotation: number;
  skin: number;
  hairStyle: number;
  hairColor: number;
  expression: number;
  intensity: Intensity;
}

const STEP_KEYS: readonly Step[] = [
  "rotation",
  "skin",
  "hairStyle",
  "hairColor",
  "expression",
  "intensity",
];

const INTENSITY_VALUES: readonly Intensity[] = ["d", "m", "h"];

const INTENSITY_LABEL_KEYS: Record<Intensity, string> = {
  d: "chill",
  m: "normal",
  h: "hyped",
};

const AVATAR_SVG_BASE = "/assets/avatar-svg";
const DEFAULT_SELECTED_INDEX = 2;
const CENTER_AVATAR_POSITION = 2;
const CENTER_AVATAR_SIZE = 112;
const SIDE_AVATAR_SIZE = 48;

const PLATFORM_AVATAR_PRESETS: readonly AvatarSvgConfig[] = [
  {
    rotation: 1,
    skin: 0,
    hairStyle: 3,
    hairColor: 2,
    expression: 3,
    intensity: "d",
  },
  {
    rotation: 2,
    skin: 1,
    hairStyle: 5,
    hairColor: 3,
    expression: 1,
    intensity: "m",
  },
  {
    rotation: 1,
    skin: 4,
    hairStyle: 1,
    hairColor: 5,
    expression: 3,
    intensity: "m",
  },
  {
    rotation: 4,
    skin: 2,
    hairStyle: 4,
    hairColor: 1,
    expression: 4,
    intensity: "h",
  },
  {
    rotation: 5,
    skin: 3,
    hairStyle: 2,
    hairColor: 4,
    expression: 5,
    intensity: "m",
  },
];

const HERO_AVATAR_ORDER: readonly number[] = [0, 1, 2, 3, 4];
const compositeAvatarSvgInnerCache = new Map<string, Promise<string>>();

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function getClampedPopoverAnchor(target: HTMLButtonElement) {
  const rect = target.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const popoverWidth = Math.min(viewportWidth - 32, 512);
  const minLeft = 16 + popoverWidth / 2;
  const maxLeft = viewportWidth - 16 - popoverWidth / 2;
  const centerLeft = rect.left + rect.width / 2;
  return {
    left: Math.min(Math.max(centerLeft, minLeft), maxLeft),
    top: rect.bottom + 12,
  };
}

function avatarSvgAssetSrc(filename: string) {
  return `${AVATAR_SVG_BASE}/${filename}`;
}

function serializeAvatarSvgConfig(config: AvatarSvgConfig) {
  return `r${config.rotation}s${config.skin}h${config.hairStyle}c${config.hairColor}f${config.expression}${config.intensity}`;
}

async function loadSvgAsset(filename: string) {
  const response = await fetch(avatarSvgAssetSrc(filename));
  if (!response.ok) {
    throw new Error(`Missing avatar SVG asset: ${filename}`);
  }
  return response.text();
}

function extractSvgInner(raw: string) {
  const open = raw.indexOf(">", raw.indexOf("<svg"));
  const close = raw.lastIndexOf("</svg>");
  if (open === -1 || close === -1) {
    return "";
  }
  return raw.slice(open + 1, close);
}

async function loadCompositeAvatarSvgInner(config: AvatarSvgConfig) {
  const [head, face, hair] = await Promise.all([
    loadSvgAsset(`head-r${config.rotation}-s${config.skin}.svg`),
    loadSvgAsset(
      `face-r${config.rotation}-f${config.expression}-${config.intensity}.svg`,
    ),
    loadSvgAsset(
      `hair-r${config.rotation}-h${config.hairStyle}-c${config.hairColor}.svg`,
    ),
  ]);
  return extractSvgInner(head) + extractSvgInner(face) + extractSvgInner(hair);
}

function getCompositeAvatarSvgInner(config: AvatarSvgConfig) {
  const key = serializeAvatarSvgConfig(config);
  const existing = compositeAvatarSvgInnerCache.get(key);
  if (existing) {
    return existing;
  }
  const promise = loadCompositeAvatarSvgInner(config);
  compositeAvatarSvgInnerCache.set(key, promise);
  return promise;
}

function AvatarSvgPreview({
  config,
  size,
  className,
}: {
  config: AvatarSvgConfig;
  size: number;
  className?: string;
}) {
  const [svgInner, setSvgInner] = useState<string | null>(null);
  const { rotation, skin, hairStyle, hairColor, expression, intensity } =
    config;

  useEffect(() => {
    let active = true;
    const nextConfig: AvatarSvgConfig = {
      rotation,
      skin,
      hairStyle,
      hairColor,
      expression,
      intensity,
    };

    setSvgInner(null);
    getCompositeAvatarSvgInner(nextConfig)
      .then((nextSvgInner) => {
        if (active) {
          setSvgInner(nextSvgInner);
        }
      })
      .catch(() => {
        if (active) {
          setSvgInner(null);
        }
      });

    return () => {
      active = false;
    };
  }, [rotation, skin, hairStyle, hairColor, expression, intensity]);

  return (
    <div
      className={cx("relative overflow-hidden rounded-full", className)}
      style={{ width: size, height: size }}
    >
      {svgInner && (
        <div className="absolute inset-0 scale-[1.25]">
          <svg
            viewBox="0 0 480 480"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="h-full w-full object-cover"
            dangerouslySetInnerHTML={{ __html: svgInner }}
          />
        </div>
      )}
    </div>
  );
}

function randomAvatarConfig(): AvatarSvgConfig {
  const randomInt = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };
  return {
    rotation: randomInt(1, 5),
    skin: randomInt(0, 4),
    hairStyle: randomInt(1, 5),
    hairColor: randomInt(1, 5),
    expression: randomInt(1, 5),
    intensity: INTENSITY_VALUES[randomInt(0, INTENSITY_VALUES.length - 1)]!,
  };
}

function HeroAvatar({
  config,
  avatarIndex,
  selected,
  size,
  onClick,
}: {
  config: AvatarSvgConfig;
  avatarIndex: number;
  selected: boolean;
  size: number;
  onClick: (target: HTMLButtonElement) => void;
}) {
  const floatDuration = 3 + (avatarIndex % 3) * 0.5;
  const floatDelay = avatarIndex * 0.7;

  return (
    <button
      type="button"
      data-testid={`hero-avatar-${avatarIndex}`}
      aria-label={`Select avatar ${avatarIndex + 1}`}
      aria-pressed={selected}
      className="group relative shrink-0 rounded-full transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ed4e01] focus-visible:ring-offset-4"
      onClick={(event) => {
        onClick(event.currentTarget);
      }}
    >
      <span
        className="block"
        style={{
          animation: `avatar-float ${floatDuration}s ease-in-out ${floatDelay}s infinite`,
        }}
      >
        <span className="block transition-transform duration-200 group-hover:scale-110">
          <AvatarSvgPreview config={config} size={size} />
        </span>
      </span>
    </button>
  );
}

const SPARKLE_COLORS = [
  "#ed4e01",
  "#E0B376",
  "#E26C9E",
  "#45A7A8",
  "#E0BB3C",
  "#FF990A",
];

function generateParticles() {
  let seed = 77;
  const rand = () => {
    seed = (seed * 16_807) % 2_147_483_647;
    return (seed - 1) / 2_147_483_646;
  };

  return Array.from({ length: 20 }, () => {
    const xDir = (rand() - 0.5) * 140;
    const yDir = -(30 + rand() * 50);
    return {
      x: xDir,
      y: yDir,
      size: 3 + rand() * 5,
      color:
        SPARKLE_COLORS[Math.floor(rand() * SPARKLE_COLORS.length)] ?? "#ed4e01",
      delay: rand() * 0.15,
    };
  });
}

const SPARKLE_PARTICLES = generateParticles();

function Sparkles({ active }: { active: boolean }) {
  if (!active) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {SPARKLE_PARTICLES.map((particle) => {
        const key = `${particle.x.toFixed(2)}_${particle.y.toFixed(
          2,
        )}_${particle.size.toFixed(2)}`;
        return (
          <div
            key={key}
            className="absolute rounded-full"
            style={
              {
                width: particle.size,
                height: particle.size,
                backgroundColor: particle.color,
                left: "50%",
                top: "10%",
                animation: "avatar-firework 0.6s ease-out forwards",
                animationDelay: `${particle.delay}s`,
                transform: "translate(-50%, -50%) scale(1)",
                "--fx": `${particle.x}px`,
                "--fy": `${particle.y}px`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

function StepNavigator({
  step,
  stepIdx,
  onBack,
  onForward,
}: {
  step: Step;
  stepIdx: number;
  onBack: () => void;
  onForward: () => void;
}) {
  const t = useTranslations("avatar");

  return (
    <>
      <div className="flex items-center gap-1">
        {STEP_KEYS.map((item, index) => {
          return (
            <div
              key={item}
              className={cx(
                "h-1.5 rounded-full transition-all duration-300",
                index === stepIdx
                  ? "w-5 bg-[#ed4e01]"
                  : index < stepIdx
                    ? "w-1.5 bg-[#ed4e01]/40"
                    : "w-1.5 bg-[hsl(var(--gray-300))]",
              )}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className={cx(
            "flex h-6 w-6 items-center justify-center rounded-full text-[#525b68] transition-colors hover:text-[#14171d]",
            stepIdx === 0 && "invisible",
          )}
          onClick={onBack}
          aria-label="Previous step"
        >
          <IconChevronLeft size={14} />
        </button>
        <p
          className="min-w-12 text-center text-xs font-semibold text-[#14171d]"
          key={step}
          style={{ animation: "avatar-option-appear 0.15s ease-out" }}
        >
          {t(`steps.${step}`)}
        </p>
        <button
          type="button"
          className={cx(
            "flex h-6 w-6 items-center justify-center rounded-full text-[#525b68] transition-colors hover:text-[#14171d]",
            stepIdx === STEP_KEYS.length - 1 && "invisible",
          )}
          onClick={onForward}
          aria-label="Next step"
        >
          <IconChevronRight size={14} />
        </button>
      </div>
    </>
  );
}

function StepOptions({
  step,
  config,
  justPicked,
  onSelect,
}: {
  step: Step;
  config: AvatarSvgConfig;
  justPicked: string | null;
  onSelect: (field: Step, value: number | Intensity) => void;
}) {
  const t = useTranslations("avatar");

  if (step === "intensity") {
    return INTENSITY_VALUES.map((value, index) => {
      const preview = { ...config, intensity: value };
      const selected = config.intensity === value;
      const picked = justPicked === `intensity-${value}`;
      return (
        <button
          key={value}
          type="button"
          className={cx(
            "flex flex-col items-center gap-1 transition-all hover:scale-110 hover:opacity-100",
            selected || picked ? "scale-110 opacity-100" : "opacity-60",
          )}
          style={{
            animation: `avatar-option-appear 0.2s ease-out ${
              index * 0.05
            }s both`,
          }}
          onClick={() => {
            onSelect("intensity", value);
          }}
        >
          <AvatarSvgPreview config={preview} size={56} />
          <span className="text-[10px] text-[#525b68]">
            {t(`intensityLabels.${INTENSITY_LABEL_KEYS[value]}`)}
          </span>
        </button>
      );
    });
  }

  const values =
    step === "skin"
      ? Array.from({ length: 5 }, (_, index) => {
          return index;
        })
      : Array.from({ length: 5 }, (_, index) => {
          return index + 1;
        });

  return values.map((value, index) => {
    const preview = { ...config, [step]: value };
    const selected = config[step] === value;
    const picked = justPicked === `${step}-${value}`;
    return (
      <button
        key={value}
        type="button"
        className={cx(
          "transition-all hover:scale-110 hover:opacity-100",
          selected || picked ? "scale-110 opacity-100" : "opacity-60",
        )}
        style={{
          animation: `avatar-option-appear 0.2s ease-out ${index * 0.05}s both`,
        }}
        onClick={() => {
          onSelect(step, value);
        }}
      >
        <AvatarSvgPreview config={preview as AvatarSvgConfig} size={56} />
      </button>
    );
  });
}

function AvatarEditorPopover({
  avatarIndex,
  anchor,
  current,
  step,
  stepIdx,
  justPicked,
  showSparkles,
  shuffling,
  shuffleAvatar,
  goBack,
  goForward,
  selectOption,
}: {
  avatarIndex: number;
  anchor: { left: number; top: number };
  current: AvatarSvgConfig;
  step: Step;
  stepIdx: number;
  justPicked: string | null;
  showSparkles: boolean;
  shuffling: boolean;
  shuffleAvatar: () => void;
  goBack: () => void;
  goForward: () => void;
  selectOption: (field: Step, value: number | Intensity) => void;
}) {
  return (
    <div
      data-testid={`avatar-editor-popover-${avatarIndex}`}
      className="fixed z-40 w-[min(calc(100vw-2rem),32rem)] overflow-hidden rounded-2xl border border-[hsl(var(--gray-200))]/50 bg-white/95 shadow-xl backdrop-blur-sm"
      style={{
        left: anchor.left,
        top: anchor.top,
        transform: "translateX(-50%)",
        animation: "avatar-popover-appear .15s ease",
      }}
    >
      <div className="flex flex-col items-center gap-3 bg-[hsl(var(--gray-100))]/60 px-6 pb-5 pt-8">
        <div
          className={cx(
            "group relative overflow-visible transition-transform duration-200",
            justPicked || shuffling ? "scale-110" : "scale-100",
          )}
        >
          <AvatarSvgPreview config={current} size={96} />
          <Sparkles active={showSparkles} />
          <button
            type="button"
            className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border border-[hsl(var(--gray-200))] bg-white text-[#525b68] shadow-sm transition-colors hover:text-[#14171d]"
            onClick={shuffleAvatar}
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
      </div>

      <div className="flex flex-col items-center gap-4 px-6 py-5">
        <StepNavigator
          step={step}
          stepIdx={stepIdx}
          onBack={goBack}
          onForward={goForward}
        />
        <div className="flex flex-wrap justify-center gap-3">
          <StepOptions
            step={step}
            config={current}
            justPicked={justPicked}
            onSelect={selectOption}
          />
        </div>
      </div>
    </div>
  );
}

export function AvatarCustomizer() {
  const [avatars, setAvatars] = useState(() => {
    return PLATFORM_AVATAR_PRESETS.map((preset) => {
      return { ...preset };
    });
  });
  const [selectedIndex, setSelectedIndex] = useState(DEFAULT_SELECTED_INDEX);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [step, setStep] = useState<Step>("rotation");
  const [justPicked, setJustPicked] = useState<string | null>(null);
  const [showSparkles, setShowSparkles] = useState(false);
  const [shuffling, setShuffling] = useState(false);
  const [popoverAnchor, setPopoverAnchor] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = editingIndex !== null ? avatars[editingIndex] : null;
  const stepIdx = STEP_KEYS.indexOf(step);

  const clearFeedbackTimer = useCallback(() => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearFeedbackTimer();
    };
  }, [clearFeedbackTimer]);

  const openEditor = useCallback(
    (index: number, target: HTMLButtonElement) => {
      setSelectedIndex(index);
      setPopoverAnchor(getClampedPopoverAnchor(target));
      if (editingIndex === index) {
        setEditingIndex(null);
        setPopoverAnchor(null);
        return;
      }
      setEditingIndex(index);
      setStep("rotation");
      setJustPicked(null);
      setShowSparkles(false);
      setShuffling(false);
      clearFeedbackTimer();
    },
    [clearFeedbackTimer, editingIndex],
  );

  const updateAvatar = useCallback(
    (updater: (currentAvatar: AvatarSvgConfig) => AvatarSvgConfig) => {
      if (editingIndex === null) {
        return;
      }
      setSelectedIndex(editingIndex);
      setAvatars((previous) => {
        return previous.map((avatar, index) => {
          return index === editingIndex ? updater(avatar) : avatar;
        });
      });
    },
    [editingIndex],
  );

  const finishFeedback = useCallback(
    (field: Step | "shuffle") => {
      clearFeedbackTimer();
      feedbackTimerRef.current = setTimeout(
        () => {
          setJustPicked(null);
          setShowSparkles(false);
          setShuffling(false);
          if (field === "shuffle") {
            return;
          }
          const nextStepIndex = STEP_KEYS.indexOf(field) + 1;
          if (nextStepIndex < STEP_KEYS.length) {
            setStep(STEP_KEYS[nextStepIndex]!);
          }
        },
        field === "shuffle" ? 600 : 350,
      );
    },
    [clearFeedbackTimer],
  );

  const selectOption = useCallback(
    (field: Step, value: number | Intensity) => {
      updateAvatar((avatar) => {
        return { ...avatar, [field]: value };
      });
      setJustPicked(`${field}-${value}`);
      setShowSparkles(true);
      finishFeedback(field);
    },
    [finishFeedback, updateAvatar],
  );

  const shuffleAvatar = useCallback(() => {
    updateAvatar(() => {
      return randomAvatarConfig();
    });
    setJustPicked("shuffle");
    setShowSparkles(true);
    setShuffling(true);
    finishFeedback("shuffle");
  }, [finishFeedback, updateAvatar]);

  const goBack = useCallback(() => {
    if (stepIdx > 0) {
      setStep(STEP_KEYS[stepIdx - 1]!);
    }
  }, [stepIdx]);

  const goForward = useCallback(() => {
    if (stepIdx + 1 < STEP_KEYS.length) {
      setStep(STEP_KEYS[stepIdx + 1]!);
    }
  }, [stepIdx]);

  return (
    <div className="relative flex items-end justify-center gap-8">
      <style>{`
        @keyframes avatar-popover-appear {
          from { opacity: 0; transform: translateX(-50%) translateY(8px) scale(0.98); }
          to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
        }
        @keyframes avatar-option-appear {
          from { opacity: 0; transform: translateY(8px) scale(0.9); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes avatar-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-8px); }
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

      {HERO_AVATAR_ORDER.map((avatarIndex, positionIndex) => {
        const config = avatars[avatarIndex]!;
        const size =
          positionIndex === CENTER_AVATAR_POSITION
            ? CENTER_AVATAR_SIZE
            : SIDE_AVATAR_SIZE;
        return (
          <div key={avatarIndex} className="relative z-30 shrink-0">
            <HeroAvatar
              config={config}
              avatarIndex={avatarIndex}
              selected={selectedIndex === avatarIndex}
              size={size}
              onClick={(target) => {
                openEditor(avatarIndex, target);
              }}
            />
          </div>
        );
      })}

      {editingIndex !== null && current && (
        <button
          type="button"
          aria-label="Close avatar editor"
          className="fixed inset-0 z-20 cursor-default"
          onClick={() => {
            setEditingIndex(null);
            setPopoverAnchor(null);
          }}
        />
      )}
      {editingIndex !== null && current && popoverAnchor && (
        <AvatarEditorPopover
          avatarIndex={editingIndex}
          anchor={popoverAnchor}
          current={current}
          step={step}
          stepIdx={stepIdx}
          justPicked={justPicked}
          showSparkles={showSparkles}
          shuffling={shuffling}
          shuffleAvatar={shuffleAvatar}
          goBack={goBack}
          goForward={goForward}
          selectOption={selectOption}
        />
      )}
    </div>
  );
}
