"use client";

import { useState, useCallback, useEffect, useRef } from "react";

type Step =
  | "rotation"
  | "skin"
  | "hairStyle"
  | "hairColor"
  | "expression"
  | "intensity";

const STEPS: { key: Step; label: string }[] = [
  { key: "rotation", label: "Angle" },
  { key: "skin", label: "Skin" },
  { key: "hairStyle", label: "Hair" },
  { key: "hairColor", label: "Color" },
  { key: "expression", label: "Face" },
  { key: "intensity", label: "Mood" },
];

const INTENSITY_LABELS: Record<string, string> = {
  d: "Chill",
  m: "Normal",
  h: "Hyped",
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
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="" src={headSrc(config.rotation, config.skin)} className={cls} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        src={hairSrc(config.rotation, config.hairStyle, config.hairColor)}
        className={cls}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        src={faceSrc(config.rotation, config.expression, config.intensity)}
        className={cls}
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
    rotation: 2,
    skin: 2,
    hairStyle: 1,
    hairColor: 1,
    expression: 2,
    intensity: "d",
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

/** Sparkle particle that appears on selection */
function Sparkles({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {Array.from({ length: 6 }, (_, i) => {
        const angle = i * 60 * (Math.PI / 180);
        const x = Math.cos(angle) * 50;
        const y = Math.sin(angle) * 50;
        return (
          <div
            key={i}
            className="absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full bg-[#ed4e01]"
            style={{
              animation: `sparkle 0.4s ease-out forwards`,
              animationDelay: `${i * 0.03}s`,
              transform: `translate(-50%, -50%)`,
              // CSS custom properties for the animation endpoint
              ["--tx" as string]: `${x}px`,
              ["--ty" as string]: `${y}px`,
            }}
          />
        );
      })}
    </div>
  );
}

export default function AvatarCustomizer() {
  const [chars, setChars] = useState(DEFAULTS);
  const [editing, setEditing] = useState<number | null>(null);
  const [step, setStep] = useState<Step>("rotation");
  const [justPicked, setJustPicked] = useState<string | null>(null);
  const [showSparkles, setShowSparkles] = useState(false);
  // Tooltip hint that disappears after first interaction
  const [showHint, setShowHint] = useState(true);
  const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const current = editing !== null ? chars[editing] : null;
  const stepIdx = STEPS.findIndex((s) => s.key === step);

  // Hide hint after 5 seconds or on first click
  useEffect(() => {
    hintTimer.current = setTimeout(() => setShowHint(false), 5000);
    return () => clearTimeout(hintTimer.current);
  }, []);

  const toggle = useCallback(
    (i: number) => {
      setShowHint(false);
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
        const idx = STEPS.findIndex((s) => s.key === field);
        const nextIdx = idx + 1;
        if (nextIdx < STEPS.length) {
          setStep(STEPS[nextIdx]!.key);
        } else {
          setEditing(null);
        }
      }, 350);
      return () => clearTimeout(timer);
    },
    [editing],
  );

  const goBack = useCallback(() => {
    if (stepIdx > 0) {
      setStep(STEPS[stepIdx - 1]!.key);
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
            onClick={() => select("intensity", val)}
          >
            <AvatarPreview config={preview} size={56} />
            <span className="text-[10px] text-[#525b68]">
              {INTENSITY_LABELS[val]}
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
          onClick={() => select(step, val)}
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
        @keyframes sparkle {
          0% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          100% { opacity: 0; transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(0); }
        }
        @keyframes hintBounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
      `}</style>

      {chars.map((c, i) => (
        <IdleAvatar
          key={i}
          config={c}
          size={i === 2 ? 132 : 54}
          index={i}
          onClick={() => toggle(i)}
          isEditing={editing === i}
        />
      ))}

      {/* "Click to customize" hint */}
      {showHint && editing === null && (
        <div
          className="absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] text-[#525b68]"
          style={{ animation: "hintBounce 1.5s ease-in-out infinite" }}
        >
          Click to customize ✨
        </div>
      )}

      {editing !== null && current && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setEditing(null)}
          />
          <div
            className="absolute left-1/2 top-full z-30 mt-3 -translate-x-1/2 flex flex-col items-center gap-4 rounded-2xl border border-[hsl(var(--gray-200))] bg-white/95 px-5 py-4 shadow-xl backdrop-blur-sm"
            style={{ animation: "fadeIn .15s ease", minWidth: 340 }}
          >
            {/* Live preview with sparkle effect */}
            <div
              className={`relative transition-transform duration-200 ${justPicked ? "scale-110" : "scale-100"}`}
            >
              <AvatarPreview config={current} size={80} />
              <Sparkles active={showSparkles} />
            </div>

            {/* Step progress */}
            <div className="flex items-center gap-1">
              {STEPS.map((s, i) => (
                <div
                  key={s.key}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === stepIdx
                      ? "w-5 bg-[#ed4e01]"
                      : i < stepIdx
                        ? "w-1.5 bg-[#ed4e01]/40"
                        : "w-1.5 bg-[hsl(var(--gray-300))]"
                  }`}
                />
              ))}
            </div>

            {/* Step label */}
            <p
              className="text-xs font-semibold text-[#14171d]"
              key={step} // re-mount on step change for animation
              style={{ animation: "optionAppear 0.15s ease-out" }}
            >
              {STEPS[stepIdx]?.label}
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
                  ← Back
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
