"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import Image from "next/image";

type Step =
  | "rotation"
  | "skin"
  | "hairStyle"
  | "hairColor"
  | "expression"
  | "intensity";

const STEP_KEYS: Step[] = [
  "rotation",
  "skin",
  "hairStyle",
  "hairColor",
  "expression",
  "intensity",
];

const INTENSITY_LABEL_KEYS: Record<string, string> = {
  d: "chill",
  m: "normal",
  h: "hyped",
};

interface AvatarConfig {
  rotation: number;
  skin: number;
  hairStyle: number;
  hairColor: number;
  expression: number;
  intensity: string;
}

const BASE = "/assets/avatar";

function headSrc(rotation: number, skin: number) {
  return `${BASE}/head-r${rotation}-s${skin}.png`;
}
function hairSrc(rotation: number, style: number, color: number) {
  return `${BASE}/hair-r${rotation}-h${style}-c${color}.png`;
}
function faceSrc(rotation: number, expr: number, intensity: string) {
  return `${BASE}/face-r${rotation}-f${expr}-${intensity}.png`;
}

function AvatarPreview({
  config,
  size,
}: {
  config: AvatarConfig;
  size: number;
}) {
  const cls = "absolute inset-0 h-full w-full";
  return (
    <div
      className="relative overflow-hidden rounded-full"
      style={{ width: size, height: size }}
    >
      <Image
        alt=""
        src={headSrc(config.rotation, config.skin)}
        className={cls}
        fill
        sizes={`${size}px`}
      />
      <Image
        alt=""
        src={hairSrc(config.rotation, config.hairStyle, config.hairColor)}
        className={cls}
        fill
        sizes={`${size}px`}
      />
      <Image
        alt=""
        src={faceSrc(config.rotation, config.expression, config.intensity)}
        className={cls}
        fill
        sizes={`${size}px`}
      />
    </div>
  );
}

const DEFAULTS: AvatarConfig[] = [
  {
    rotation: 1,
    skin: 1,
    hairStyle: 3,
    hairColor: 2,
    expression: 3,
    intensity: "d",
  },
  {
    rotation: 2,
    skin: 3,
    hairStyle: 5,
    hairColor: 4,
    expression: 1,
    intensity: "m",
  },
  {
    rotation: 1,
    skin: 2,
    hairStyle: 1,
    hairColor: 1,
    expression: 3,
    intensity: "m",
  },
  {
    rotation: 4,
    skin: 4,
    hairStyle: 4,
    hairColor: 3,
    expression: 4,
    intensity: "h",
  },
  {
    rotation: 5,
    skin: 5,
    hairStyle: 2,
    hairColor: 5,
    expression: 5,
    intensity: "m",
  },
];

/** Floating idle animation for each avatar slot */
function IdleAvatar({
  config,
  size,
  index,
  onClick,
  isEditing,
}: {
  config: AvatarConfig;
  size: number;
  index: number;
  onClick: () => void;
  isEditing: boolean;
}) {
  // Each avatar gets a unique animation delay so they bob at different phases
  const delay = index * 0.7;
  const duration = 3 + (index % 3) * 0.5; // slightly different speeds

  return (
    <div
      className={`shrink-0 cursor-pointer transition-transform hover:scale-110 ${isEditing ? "scale-105" : ""}`}
      style={{
        animation: isEditing
          ? "none"
          : `avatarFloat ${duration}s ease-in-out ${delay}s infinite`,
      }}
      onClick={onClick}
    >
      <AvatarPreview config={config} size={size} />
    </div>
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
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
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

/** Firework particles that burst from the sides on selection */
function Sparkles({ active }: { active: boolean }) {
  if (!active) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {SPARKLE_PARTICLES.map((p, i) => {
        return (
          <div
            key={i}
            className="absolute rounded-full"
            style={{
              width: p.size,
              height: p.size,
              backgroundColor: p.color,
              left: "50%",
              top: "10%",
              animation: `firework 0.6s ease-out forwards`,
              animationDelay: `${p.delay}s`,
              transform: "translate(-50%, -50%) scale(1)",
              ["--fx" as string]: `${p.x}px`,
              ["--fy" as string]: `${p.y}px`,
            }}
          />
        );
      })}
    </div>
  );
}

export function AvatarCustomizer() {
  const [chars, setChars] = useState(DEFAULTS);
  const [editing, setEditing] = useState<number | null>(null);
  const [step, setStep] = useState<Step>("rotation");
  const [justPicked, setJustPicked] = useState<string | null>(null);
  const [showSparkles, setShowSparkles] = useState(false);
  const t = useTranslations("avatar");
  // Tooltip hint that disappears after first interaction

  const current = editing !== null ? chars[editing] : null;
  const stepIdx = STEP_KEYS.indexOf(step);

  const toggle = useCallback(
    (i: number) => {
      if (editing === i) {
        setEditing(null);
        return;
      }
      setEditing(i);
      setStep("rotation");
    },
    [editing],
  );

  const select = useCallback(
    (field: Step, value: number | string) => {
      if (editing === null) return;
      setJustPicked(`${field}-${value}`);
      setShowSparkles(true);
      setChars((prev) => {
        const next = [...prev];
        next[editing] = { ...next[editing]!, [field]: value };
        return next;
      });
      const timer = setTimeout(() => {
        setJustPicked(null);
        setShowSparkles(false);
        const idx = STEP_KEYS.indexOf(field);
        const nextIdx = idx + 1;
        if (nextIdx < STEP_KEYS.length) {
          setStep(STEP_KEYS[nextIdx]!);
        } else {
          setEditing(null);
        }
      }, 350);
      return () => {
        return clearTimeout(timer);
      };
    },
    [editing],
  );

  const goBack = useCallback(() => {
    if (stepIdx > 0) {
      setStep(STEP_KEYS[stepIdx - 1]!);
    }
  }, [stepIdx]);

  function renderOptions() {
    if (!current) return null;

    if (step === "intensity") {
      return (["d", "m", "h"] as const).map((val, i) => {
        const isPicked = justPicked === `intensity-${val}`;
        const preview = { ...current, intensity: val };
        return (
          <button
            key={val}
            type="button"
            className={`flex flex-col items-center gap-1 rounded-full transition-all hover:scale-110 ${isPicked ? "scale-110 ring-2 ring-[#ed4e01] ring-offset-2" : ""}`}
            style={{
              animation: `optionAppear 0.2s ease-out ${i * 0.05}s both`,
            }}
            onClick={() => {
              return select("intensity", val);
            }}
          >
            <AvatarPreview config={preview} size={56} />
            <span className="text-[10px] text-[#525b68]">
              {t(`intensityLabels.${INTENSITY_LABEL_KEYS[val]}`)}
            </span>
          </button>
        );
      });
    }

    return Array.from({ length: 5 }, (_, i) => {
      const val = i + 1;
      const isPicked = justPicked === `${step}-${val}`;
      const preview = { ...current, [step]: val };
      return (
        <button
          key={val}
          type="button"
          className={`rounded-full transition-all hover:scale-110 ${isPicked ? "scale-110 ring-2 ring-[#ed4e01] ring-offset-2" : ""}`}
          style={{ animation: `optionAppear 0.2s ease-out ${i * 0.05}s both` }}
          onClick={() => {
            return select(step, val);
          }}
        >
          <AvatarPreview config={preview as AvatarConfig} size={56} />
        </button>
      );
    });
  }

  return (
    <div className="relative flex items-end justify-center gap-4">
      {/* Inline keyframes */}
      <style>{`
        @keyframes avatarFloat {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-8px); }
        }
        @keyframes avatarPulse {
          0%, 100% { transform: scale(1); opacity: 0.4; }
          50% { transform: scale(1.15); opacity: 0; }
        }
        @keyframes optionAppear {
          from { opacity: 0; transform: translateY(8px) scale(0.9); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes firework {
          0% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          70% { opacity: 0.8; }
          100% { opacity: 0; transform: translate(calc(-50% + var(--fx)), calc(-50% + var(--fy))) scale(0.3); }
        }
      `}</style>

      {chars.map((c, i) => {
        return (
          <IdleAvatar
            key={i}
            config={c}
            size={i === 2 ? 132 : 54}
            index={i}
            onClick={() => {
              return toggle(i);
            }}
            isEditing={editing === i}
          />
        );
      })}

      {editing !== null && current && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => {
              return setEditing(null);
            }}
          />
          <div
            className="absolute left-1/2 top-full z-30 mt-3 -translate-x-1/2 flex flex-col items-center gap-4 rounded-2xl border border-[hsl(var(--gray-200))]/50 bg-white/95 px-5 py-4 shadow-lg backdrop-blur-sm"
            style={{ animation: "fadeIn .15s ease", minWidth: 340 }}
          >
            {/* Live preview with sparkle effect */}
            <div
              className={`relative overflow-visible transition-transform duration-200 ${justPicked ? "scale-110" : "scale-100"}`}
            >
              <AvatarPreview config={current} size={80} />
              <Sparkles active={showSparkles} />
            </div>

            {/* Step progress */}
            <div className="flex items-center gap-1">
              {STEP_KEYS.map((s, i) => {
                return (
                  <div
                    key={s}
                    className={`h-1.5 rounded-full transition-all duration-300 ${
                      i === stepIdx
                        ? "w-5 bg-[#ed4e01]"
                        : i < stepIdx
                          ? "w-1.5 bg-[#ed4e01]/40"
                          : "w-1.5 bg-[hsl(var(--gray-300))]"
                    }`}
                  />
                );
              })}
            </div>

            {/* Step label */}
            <p
              className="text-xs font-semibold text-[#14171d]"
              key={step} // re-mount on step change for animation
              style={{ animation: "optionAppear 0.15s ease-out" }}
            >
              {STEP_KEYS[stepIdx] ? t(`steps.${STEP_KEYS[stepIdx]}`) : ""}
            </p>

            {/* Options with staggered entrance */}
            <div className="flex gap-3">{renderOptions()}</div>

            {/* Back button */}
            <div className="flex w-full">
              {stepIdx > 0 ? (
                <button
                  type="button"
                  className="text-xs text-[#525b68] hover:text-[#14171d]"
                  onClick={goBack}
                >
                  {t("back")}
                </button>
              ) : (
                <span />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
