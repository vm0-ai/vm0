"use client";

import { useEffect, useRef, useState } from "react";
import NextLink from "next/link";
import { useUser } from "@clerk/nextjs";
import { useTranslations } from "next-intl";
import { getAppUrl } from "../../src/lib/zero/url";
import { buildSignupHref } from "../../src/lib/adAttribution";
import { Footer } from "./Footer";
import Image from "next/image";
import { AvatarCustomizer } from "./AvatarCustomizer";

function useScrollReveal() {
  const ref = useRef<HTMLDivElement>(null);
  const revealedRef = useRef(new Set<Element>());
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !revealedRef.current.has(entry.target)) {
            revealedRef.current.add(entry.target);
            entry.target.classList.add("revealed");
            observerRef.current?.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1 },
    );
    const el = ref.current;
    if (el) {
      el.querySelectorAll(".reveal").forEach((child) => {
        if (!revealedRef.current.has(child)) {
          observerRef.current?.observe(child);
        }
      });
    }
    return () => {
      return observerRef.current?.disconnect();
    };
  }, []);

  return ref;
}

const CONNECTORS_ROW1: {
  name: string;
  icon: string;
  dark?: boolean;
  darkIcon?: string;
}[] = [
  { name: "Axiom", icon: "/assets/connectors/axiom.svg", dark: true },
  { name: "Ahrefs", icon: "/assets/connectors/ahref.svg" },
  { name: "Airtable", icon: "/assets/connectors/airtable.svg" },
  { name: "Gmail", icon: "/assets/connectors/gmail.svg" },
  { name: "Google Sheets", icon: "/assets/connectors/google-sheet.svg" },
  { name: "Notion", icon: "/assets/connectors/notion.svg", dark: true },
  { name: "DocuSign", icon: "/assets/connectors/docusign.svg" },
  { name: "Linear", icon: "/assets/connectors/linear.svg" },
];

const CONNECTORS_ROW2: {
  name: string;
  icon: string;
  dark?: boolean;
  darkIcon?: string;
}[] = [
  { name: "Google Calendar", icon: "/assets/connectors/google-calendar.svg" },
  { name: "Intercom", icon: "/assets/connectors/intercom.svg", dark: true },
  {
    name: "Deel",
    icon: "/assets/connectors/deel.svg",
    darkIcon: "/assets/connectors/deel-dark.svg",
  },
  { name: "HubSpot", icon: "/assets/connectors/hubspot.svg" },
  { name: "Dropbox", icon: "/assets/connectors/dropbox.svg" },
  { name: "Sentry", icon: "/assets/connectors/sentry.svg", dark: true },
  { name: "Figma", icon: "/assets/connectors/figma.svg" },
  { name: "Vercel", icon: "/assets/connectors/vercel.svg", dark: true },
];

function CtaButton({
  isSignedIn,
  ctaText,
  ctaHref,
  className,
}: {
  isSignedIn: boolean;
  ctaText: string;
  ctaHref: string;
  className?: string;
}) {
  const baseClassName = `inline-flex items-center justify-center whitespace-nowrap rounded-xl px-8 py-3.5 text-base font-medium transition-all hover:bg-[#ff6a1f] sm:px-14 ${className ?? ""}`;
  const style = {
    background: "#ed4e01",
    boxShadow: "inset 0 -2px 0 #a33703",
    color: "#ffffff",
  };

  if (isSignedIn) {
    return (
      <a
        href={ctaHref}
        target="_blank"
        rel="noopener noreferrer"
        className={baseClassName}
        style={style}
      >
        {ctaText}
      </a>
    );
  }

  return (
    <NextLink href={ctaHref} className={baseClassName} style={style}>
      {ctaText}
    </NextLink>
  );
}

function AddToSlackButton({ className }: { className?: string }) {
  return (
    <NextLink
      href="/api/zero/slack/oauth/install"
      aria-label="Add to Slack"
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-[hsl(var(--gray-300))] px-6 py-3.5 text-base font-medium text-[hsl(var(--foreground))] transition-all hover:bg-[hsl(var(--gray-100))] sm:px-8 ${className ?? ""}`}
    >
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/assets/mockup/slack.svg"
          alt=""
          className="h-5 w-5 max-w-none scale-[2.2]"
        />
      </span>
      Add to Slack
    </NextLink>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="landing-heading text-center text-[28px] font-medium leading-[1.2] tracking-[-0.88px] text-[hsl(var(--foreground))] sm:text-[34px] md:text-[40px]">
      {children}
    </h2>
  );
}

/** Toggles `in-view` class each time element enters/leaves viewport */
function useInView(threshold = 0.3) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) el.classList.add("in-view");
        else el.classList.remove("in-view");
      },
      { threshold },
    );
    observer.observe(el);
    return () => {
      return observer.disconnect();
    };
  }, [threshold]);
  return ref;
}

interface ComparisonItem {
  key: string;
  iconBg: string;
  iconSrc?: string;
  initial?: string;
}

const COMPARISON_ITEMS: ComparisonItem[] = [
  { key: "manus", iconSrc: "/assets/connectors/manus.svg", iconBg: "#F3F4F6" },
  {
    key: "openclaw",
    iconSrc: "/assets/connectors/openclaw.svg",
    iconBg: "#F3F4F6",
  },
  {
    key: "zapier",
    iconSrc: "/assets/connectors/zapier.svg",
    iconBg: "#F3F4F6",
  },
  {
    key: "claudeCode",
    iconSrc: "/assets/connectors/anthropic.svg",
    iconBg: "#F3F4F6",
  },
];

function CompetitorIcon({ item }: { item: ComparisonItem }) {
  return (
    <div
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]"
      style={{ backgroundColor: item.iconBg }}
    >
      {item.iconSrc ? (
        <Image
          src={item.iconSrc}
          alt=""
          width={24}
          height={24}
          className="h-6 w-6"
        />
      ) : (
        <span className="text-base font-semibold text-[hsl(var(--foreground))]">
          {item.initial}
        </span>
      )}
    </div>
  );
}

function RoleCard({
  t,
  roleKey,
  image,
  imageAlt,
  imageBg,
  imageLayout = "contain",
}: {
  t: (key: string) => string;
  roleKey: string;
  image: string;
  imageAlt: string;
  imageBg: string;
  imageLayout?: "contain" | "bottom";
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  return (
    <div className="overflow-hidden rounded-[20px] bg-white md:h-[440px]">
      <div className="flex h-full flex-col md:flex-row">
        {/* Left: Role header + internal accordion */}
        <div className="flex w-full flex-col gap-4 p-7 sm:p-8 md:w-[480px] md:shrink-0">
          <div className="flex flex-col gap-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-[1.5px] text-[#ed4e01]">
              {t(`roleShowcase.${roleKey}.label`)}
            </span>
            <h3 className="text-2xl font-medium leading-8 text-[hsl(var(--foreground))]">
              {t(`roleShowcase.${roleKey}.tagline`)}
            </h3>
          </div>

          {/* Use-case accordion — 4 items, single-select, first open by default */}
          <div className="flex flex-col">
            {[0, 1, 2, 3].map((idx) => {
              const i = idx + 1;
              const isOpen = idx === activeIndex;
              return (
                <div
                  key={i}
                  className="border-t border-[hsl(var(--foreground)/0.06)] last:border-b"
                >
                  <button
                    type="button"
                    onClick={() => {
                      return setActiveIndex(idx);
                    }}
                    aria-expanded={isOpen}
                    className="group flex w-full items-center gap-3 py-3 text-left"
                  >
                    <span className="flex-1 text-[15px] font-medium text-[hsl(var(--foreground))] transition-colors group-hover:text-[#ed4e01]">
                      {t(`roleShowcase.${roleKey}.bullet${i}Title`)}
                    </span>
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 14 14"
                      fill="none"
                      aria-hidden="true"
                      className={`shrink-0 text-[hsl(var(--foreground)/0.35)] transition-[transform,color] duration-300 group-hover:text-[#ed4e01] ${
                        isOpen ? "rotate-180" : ""
                      }`}
                    >
                      <path
                        d="M3 5l4 4 4-4"
                        stroke="currentColor"
                        strokeWidth="1.25"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <div
                    className={`grid transition-[grid-template-rows] duration-300 ease-out ${
                      isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                    }`}
                  >
                    <div className="overflow-hidden">
                      <p className="pb-3 text-sm leading-5 text-[hsl(var(--muted-foreground))]">
                        {t(`roleShowcase.${roleKey}.bullet${i}Desc`)}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Static image for this role */}
        {imageLayout === "bottom" ? (
          <div
            className="flex flex-1 items-end justify-center overflow-hidden px-6 pt-8 sm:px-10 sm:pt-10 md:h-full"
            style={{ backgroundColor: imageBg }}
          >
            <Image
              alt={imageAlt}
              src={image}
              width={800}
              height={500}
              className="h-auto max-h-full w-auto max-w-full"
              draggable={false}
            />
          </div>
        ) : (
          <div
            className="flex flex-1 items-center justify-center overflow-hidden p-4 sm:p-6 md:h-full"
            style={{ backgroundColor: imageBg }}
          >
            <Image
              alt={imageAlt}
              src={image}
              width={800}
              height={500}
              className="max-h-full max-w-full object-contain"
              draggable={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Cube with particle shield illustration ── */

function MemoryMockupArea() {
  const ref = useInView();
  return (
    <div
      ref={ref}
      className="flex-1 overflow-hidden rounded-b-[20px] bg-[#e0bb3c] px-8 pb-16 pt-8 sm:px-10 sm:pb-20 sm:pt-10"
    >
      <div className="memory-pop flex min-h-[200px] flex-col rounded-[10px] bg-white p-4">
        <div className="flex justify-end">
          <div className="max-w-[291px] rounded-[12px] bg-[rgba(230,234,239,0.95)] px-[10px] py-[7px]">
            <p className="text-[11.6px] leading-[18.8px] text-[#15181e]">
              Audit vm0.ai pages against <strong>our product direction</strong>{" "}
              and <strong>past decisions</strong>. Flag what to keep, update, or
              remove, with SEO improvements and next steps. Create a Linear
              project with structured issues for the{" "}
              <strong>right owners</strong>.
            </p>
          </div>
        </div>
        <div className="mt-[5px] pt-[7px]">
          <p className="text-[11.6px] leading-[18.8px] text-[#15181e]">
            Research complete. Full report ready. All vm0.ai pages are mapped
            and synced to Notion{" "}
            <span className="font-medium text-[#06679f]">here</span>
            <span className="font-medium text-[#075786]">.</span>
          </p>
        </div>
      </div>
    </div>
  );
}

function ScheduleMockupArea() {
  const ref = useInView();
  return (
    <div
      ref={ref}
      className="flex-1 overflow-hidden rounded-b-[20px] bg-[#ed71a5] px-8 pb-16 pt-8 sm:px-10 sm:pb-20 sm:pt-10"
    >
      <div className="schedule-pop flex min-h-[200px] flex-col overflow-hidden rounded-[10px] bg-white p-4 shadow-[0px_1.6px_101px_40px_rgba(0,0,0,0.08)]">
        <div className="flex w-full flex-col gap-[13px]">
          <div className="flex w-full flex-col gap-1">
            <span className="text-[11.6px] font-semibold text-black">
              {"Zero's schedule"}
            </span>
            <span className="overflow-hidden text-ellipsis text-[11.6px] text-[hsl(var(--muted-foreground))]">
              Set time and prompt for Zero to run automatically
            </span>
          </div>
          <div className="w-full rounded-[8px] bg-[#f3f5f8] p-[10px]">
            <div className="flex flex-col gap-[7px]">
              <span className="text-[11.6px] font-semibold text-[#15181e]">
                SEO diagnosis
              </span>
              <span className="text-[11.6px] text-[hsl(var(--muted-foreground))]">
                Draft the weekly team report from the last 7 days and save to
                the shared drive.
              </span>
              <div className="flex h-[13px] w-[24px] items-center rounded-full bg-[#ef5001] pl-[12px] pr-[1px] py-[1px]">
                <div className="schedule-pop-toggle size-[10.5px] rounded-full bg-white shadow-[0px_7px_10px_-2px_rgba(0,0,0,0.1),0px_3px_4px_-3px_rgba(0,0,0,0.1)]" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Pre-compute shield illustration nodes at module level to avoid render-time mutation
const SHIELD_NODES = (() => {
  const cx = 200;
  const cy = 160;
  const colors = ["#45A7A8", "#7587BA", "#E0B376", "#E26C9E", "#E0BB3C"];
  let seed = 42;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const nodes: {
    x: number;
    y: number;
    r: number;
    opacity: number;
    delay: number;
    color: string;
    dx1: number;
    dy1: number;
    dx2: number;
    dy2: number;
    dx3: number;
    dy3: number;
    dur: number;
  }[] = [];
  for (let i = 0; i < 60; i++) {
    const angle = rand() * Math.PI * 2;
    const distBase = i < 10 ? 25 + rand() * 50 : 60 + rand() * 120;
    const x = cx + Math.cos(angle) * distBase;
    const y = cy + Math.sin(angle) * distBase * 0.8;
    const r = 0.8 + rand() * 1.5;
    const opacity = 0.3 + rand() * 0.5;
    const delay = rand() * 5;
    const color = colors[Math.floor(rand() * colors.length)] ?? "#45A7A8";
    const dx1 = (rand() - 0.5) * 16;
    const dy1 = (rand() - 0.5) * 12;
    const dx2 = (rand() - 0.5) * 20;
    const dy2 = (rand() - 0.5) * 14;
    const dx3 = (rand() - 0.5) * 16;
    const dy3 = (rand() - 0.5) * 12;
    const dur = 6 + rand() * 8;
    nodes.push({
      x,
      y,
      r,
      opacity,
      delay,
      color,
      dx1,
      dy1,
      dx2,
      dy2,
      dx3,
      dy3,
      dur,
    });
  }
  const lines: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    opacity: number;
    color: string;
    delay: number;
  }[] = [];
  const maxDist = 65;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const ni = nodes[i]!;
      const nj = nodes[j]!;
      const dx = ni.x - nj.x;
      const dy = ni.y - nj.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < maxDist) {
        const opacity = (1 - dist / maxDist) * 0.25;
        lines.push({
          x1: ni.x,
          y1: ni.y,
          x2: nj.x,
          y2: nj.y,
          opacity,
          color: ni.color,
          delay: Math.min(ni.delay, nj.delay),
        });
      }
    }
  }
  return { nodes, lines, cx, cy };
})();

function CubeShieldIllustration() {
  const { nodes, lines, cx, cy } = SHIELD_NODES;

  return (
    <svg
      viewBox="0 0 400 320"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="w-full max-w-[448px]"
    >
      <style>{`
        @keyframes sparkle {
          0%, 100% { opacity: var(--base-o); transform: translate(0,0); }
          25% { transform: translate(var(--dx1), var(--dy1)); }
          50% { opacity: calc(var(--base-o) * 0.3); transform: translate(var(--dx2), var(--dy2)); }
          75% { transform: translate(var(--dx3), var(--dy3)); }
        }
        @keyframes linePulse {
          0%, 100% { opacity: var(--base-o); }
          50% { opacity: 0; }
        }
        .sp { animation: sparkle var(--dur) ease-in-out infinite; }
        .ln { animation: linePulse 4s ease-in-out infinite; }
      `}</style>
      <defs>
        <linearGradient
          id="csg0"
          x1="181"
          y1="205"
          x2="181"
          y2="145"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#CAD1E7" />
          <stop offset="1" stopColor="#B4BDD8" />
        </linearGradient>
        <linearGradient
          id="csg1"
          x1="34.5"
          y1="0.7"
          x2="7"
          y2="56"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#CFD8EF" />
          <stop offset="1" stopColor="#D5DAE9" />
        </linearGradient>
        <linearGradient
          id="csg2"
          x1="200"
          y1="97"
          x2="181"
          y2="145"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EDF1FD" />
          <stop offset="1" stopColor="#E1E5F1" />
        </linearGradient>
      </defs>
      {/* Back particles — behind cube (upper half, farther away) */}
      {lines
        .filter((_, i) => {
          return i % 2 === 0;
        })
        .map((l, i) => {
          return (
            <line
              key={`lb${i}`}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke={l.color}
              strokeWidth="0.5"
              className="ln"
              style={
                {
                  "--base-o": l.opacity,
                  animationDelay: `${l.delay}s`,
                } as React.CSSProperties
              }
            />
          );
        })}
      {nodes
        .filter((p) => {
          return p.y < cy || Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2) > 100;
        })
        .map((p, i) => {
          return (
            <circle
              key={`nb${i}`}
              cx={p.x}
              cy={p.y}
              r={p.r}
              fill={p.color}
              className="sp"
              style={
                {
                  "--base-o": p.opacity,
                  "--dx1": `${p.dx1}px`,
                  "--dy1": `${p.dy1}px`,
                  "--dx2": `${p.dx2}px`,
                  "--dy2": `${p.dy2}px`,
                  "--dx3": `${p.dx3}px`,
                  "--dy3": `${p.dy3}px`,
                  "--dur": `${p.dur}s`,
                  animationDelay: `${p.delay}s`,
                } as React.CSSProperties
              }
            />
          );
        })}
      {/* Cube — translucent glass with depth */}
      <g transform="translate(140,90)">
        {/* Left face */}
        <path
          d="M0 35.4L60 70V140L0 104.6V35.4Z"
          fill="#3a8e8f"
          opacity="0.25"
        />
        {/* Right face */}
        <rect
          width="69.2"
          height="69.2"
          transform="matrix(0.866 -0.5 0 1 60 70)"
          fill="#5a7ab5"
          opacity="0.2"
        />
        {/* Top face */}
        <path
          d="M60 0L120 35.4L60 70L0 35.4L60 0Z"
          fill="#6ecfcf"
          opacity="0.22"
        />
        {/* Outer edges */}
        <path
          d="M60 0L120 35.4L120 104.6L60 140L0 104.6L0 35.4Z"
          stroke="#45A7A8"
          strokeWidth="1.2"
          opacity="0.6"
          fill="none"
        />
        <line
          x1="0"
          y1="35.4"
          x2="60"
          y2="70"
          stroke="#45A7A8"
          strokeWidth="0.8"
          opacity="0.5"
        />
        <line
          x1="120"
          y1="35.4"
          x2="60"
          y2="70"
          stroke="#45A7A8"
          strokeWidth="0.8"
          opacity="0.4"
        />
        <line
          x1="60"
          y1="70"
          x2="60"
          y2="140"
          stroke="#45A7A8"
          strokeWidth="0.8"
          opacity="0.5"
        />
        {/* Hidden edges — dashed */}
        <line
          x1="60"
          y1="0"
          x2="60"
          y2="70"
          stroke="#45A7A8"
          strokeWidth="0.5"
          opacity="0.2"
          strokeDasharray="2 2"
        />
        <line
          x1="0"
          y1="104.6"
          x2="60"
          y2="70"
          stroke="#45A7A8"
          strokeWidth="0.4"
          opacity="0.15"
          strokeDasharray="2 2"
        />
        <line
          x1="120"
          y1="104.6"
          x2="60"
          y2="70"
          stroke="#45A7A8"
          strokeWidth="0.4"
          opacity="0.15"
          strokeDasharray="2 2"
        />
        {/* Inner cube */}
        <g transform="translate(30,17.7) scale(0.5)">
          <path
            d="M0 35.4L60 70V140L0 104.6V35.4Z"
            fill="#3a8e8f"
            opacity="0.35"
          />
          <rect
            width="69.2"
            height="69.2"
            transform="matrix(0.866 -0.5 0 1 60 70)"
            fill="#5a7ab5"
            opacity="0.28"
          />
          <path
            d="M60 0L120 35.4L60 70L0 35.4L60 0Z"
            fill="#6ecfcf"
            opacity="0.3"
          />
          <path
            d="M60 0L120 35.4L120 104.6L60 140L0 104.6L0 35.4Z"
            stroke="#45A7A8"
            strokeWidth="1.5"
            opacity="0.55"
            fill="none"
          />
          <line
            x1="60"
            y1="70"
            x2="60"
            y2="140"
            stroke="#45A7A8"
            strokeWidth="1"
            opacity="0.45"
          />
          <line
            x1="0"
            y1="35.4"
            x2="60"
            y2="70"
            stroke="#45A7A8"
            strokeWidth="1"
            opacity="0.45"
          />
          <line
            x1="120"
            y1="35.4"
            x2="60"
            y2="70"
            stroke="#45A7A8"
            strokeWidth="1"
            opacity="0.45"
          />
        </g>
      </g>
      {/* Front particles — in front of cube (lower half, closer) */}
      {lines
        .filter((_, i) => {
          return i % 2 === 1;
        })
        .map((l, i) => {
          return (
            <line
              key={`lf${i}`}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke={l.color}
              strokeWidth="0.5"
              className="ln"
              style={
                {
                  "--base-o": l.opacity,
                  animationDelay: `${l.delay}s`,
                } as React.CSSProperties
              }
            />
          );
        })}
      {nodes
        .filter((p) => {
          return (
            p.y >= cy && Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2) <= 100
          );
        })
        .map((p, i) => {
          return (
            <circle
              key={`nf${i}`}
              cx={p.x}
              cy={p.y}
              r={p.r}
              fill={p.color}
              className="sp"
              style={
                {
                  "--base-o": p.opacity,
                  "--dx1": `${p.dx1}px`,
                  "--dy1": `${p.dy1}px`,
                  "--dx2": `${p.dx2}px`,
                  "--dy2": `${p.dy2}px`,
                  "--dx3": `${p.dx3}px`,
                  "--dy3": `${p.dy3}px`,
                  "--dur": `${p.dur}s`,
                  animationDelay: `${p.delay}s`,
                } as React.CSSProperties
              }
            />
          );
        })}
    </svg>
  );
}

interface LandingPageProps {
  initialIsSignedIn?: boolean;
}

export function LandingPage({ initialIsSignedIn = false }: LandingPageProps) {
  const { isSignedIn: clerkIsSignedIn, isLoaded } = useUser();
  const isSignedIn = isLoaded ? clerkIsSignedIn : initialIsSignedIn;
  const revealRef = useScrollReveal();
  const t = useTranslations("landing");

  // Forward inbound ad attribution (gclid/utm) from the homepage into the app
  // so paid campaigns landing here keep their attribution into Stripe/Clerk.
  const appUrl = getAppUrl();
  const [landingSearch, setLandingSearch] = useState("");
  useEffect(() => {
    setLandingSearch(window.location.search);
  }, []);

  const ctaText = isSignedIn ? t("hero.ctaOpenApp") : t("hero.ctaGetStarted");
  const ctaHref = isSignedIn ? appUrl : buildSignupHref(appUrl, landingSearch);

  return (
    <div
      ref={revealRef}
      className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]"
    >
      {/* Noise grain overlay — full page */}
      <svg
        className="landing-noise pointer-events-none fixed inset-0 z-0 h-full w-full opacity-[0.018]"
        aria-hidden="true"
      >
        <filter id="page-noise">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.8"
            numOctaves="4"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#page-noise)" />
      </svg>

      {/* Corner grid overlay — visible at corners, fades to transparent in center */}
      <div
        className="landing-grid pointer-events-none fixed inset-0 z-0"
        aria-hidden="true"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--foreground) / 0.06) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground) / 0.06) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
          maskImage:
            "radial-gradient(ellipse 70% 65% at 50% 50%, transparent 50%, black 100%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 70% 65% at 50% 50%, transparent 50%, black 100%)",
        }}
      />

      <main>
        {/* ===== HERO SECTION ===== */}
        <section className="relative flex flex-col items-center overflow-hidden px-5 pt-[var(--total-header-height,80px)] sm:px-6">
          {/* Decorative background shapes */}
          <div
            className="pointer-events-none absolute inset-x-0 z-[1] sm:left-[12.31%] sm:right-[12.82%]"
            style={{
              top: "50%",
              transform: "translateY(-50%)",
              height: "80%",
            }}
          >
            <Image
              src="/assets/hero/decorative-shapes.svg"
              alt=""
              className="deco-shapes"
              fill
              priority
            />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-[1060px] flex-col items-center gap-[50px] pb-10 pt-[140px]">
            <div className="flex w-full flex-col items-center gap-8">
              {/* Banner pill — hidden for now */}
              <NextLink
                href="/blog"
                className="hidden items-center gap-2 rounded-lg border border-[hsl(var(--gray-200))] bg-white px-3 py-1.5 text-sm text-[hsl(var(--foreground))] transition-colors hover:border-[hsl(var(--gray-400))] hover:bg-white"
              >
                <Image
                  src="/assets/hero/announcement-icon.svg"
                  alt=""
                  width={22}
                  height={16}
                  className="h-4 w-[22px]"
                />
                <span>{t("hero.seedBanner")}</span>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  className="shrink-0"
                >
                  <path
                    d="M3.33 8h9.34M8.67 4l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </NextLink>

              {/* Interactive avatar customizer */}
              <AvatarCustomizer />

              {/* Heading + Subtitle */}
              <div className="flex w-full flex-col items-center gap-[15px] text-center">
                <h1 className="w-full text-[32px] font-medium leading-[1.4] tracking-[-1.12px] text-[hsl(var(--foreground))] sm:text-[42px] md:text-[51px]">
                  {t("hero.title")}
                </h1>
                <p className="max-w-2xl text-[16px] leading-7 text-[hsl(var(--muted-foreground))] sm:text-[18px]">
                  {t("hero.subtitle")}
                </p>
              </div>
            </div>

            {/* CTA Buttons — hero large */}
            <div className="relative flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center sm:gap-4">
              <CtaButton
                isSignedIn={isSignedIn ?? false}
                ctaText={ctaText}
                ctaHref={ctaHref}
              />
              <AddToSlackButton />
            </div>
          </div>
        </section>

        {/* ===== WORKS FOR YOU SECTION ===== */}
        <section className="px-5 py-10 sm:px-6 sm:py-12 md:py-16">
          <div className="mx-auto max-w-[1152px]">
            <div className="reveal">
              <SectionHeading>{t("worksForYou.heading")}</SectionHeading>
            </div>

            <div className="mt-12 space-y-8 sm:mt-16">
              <div className="reveal">
                <RoleCard
                  t={t}
                  roleKey="founders"
                  image="/assets/mockup/web-ui-1.png"
                  imageAlt="Daily business brief generated by Zero"
                  imageBg="#d58341"
                />
              </div>
              <div className="reveal">
                <RoleCard
                  t={t}
                  roleKey="sales"
                  image="/assets/mockup/across-tools.png"
                  imageAlt="KOL research synced from X into a Notion tracker"
                  imageBg="#39A2A3"
                />
              </div>
              <div className="reveal">
                <RoleCard
                  t={t}
                  roleKey="engineering"
                  image="/assets/mockup/web-ui-3.png"
                  imageAlt="Sentry error triage report"
                  imageBg="#546887"
                />
              </div>
              <div className="reveal">
                <RoleCard
                  t={t}
                  roleKey="operations"
                  image="/assets/mockup/atslack.png"
                  imageAlt="Weekly status summary written inside Slack"
                  imageBg="#9a948d"
                  imageLayout="bottom"
                />
              </div>

              {/* More use cases link */}
              <div className="reveal flex justify-center pt-4">
                <NextLink
                  href="/use-cases"
                  className="inline-flex items-center gap-2 rounded-xl px-6 py-3 text-base font-medium text-[hsl(var(--foreground))] transition-all border border-[hsl(var(--gray-300))] hover:bg-[hsl(var(--gray-100))]"
                >
                  {t("worksForYou.exploreMore")}
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M3.33 8h9.34M8.67 4l4 4-4 4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </NextLink>
              </div>
            </div>
          </div>
        </section>

        {/* ===== CONNECTORS SECTION ===== */}
        <section className="px-5 py-10 sm:px-6 sm:py-12 md:py-16">
          <div className="mx-auto flex max-w-[1060px] flex-col items-center gap-10">
            {/* Title block */}
            <div className="reveal flex flex-col items-center gap-4 rounded-[32px] px-2 pb-2 pt-6">
              <h2 className="landing-heading text-center text-[28px] font-medium leading-[1.2] tracking-[-0.88px] text-[hsl(var(--foreground))] sm:text-[34px] md:text-[40px]">
                {t("connectors.heading")}
              </h2>
              <p className="max-w-[856px] text-center text-base leading-6 text-[hsl(var(--muted-foreground))]">
                {t("connectors.description")}
              </p>
            </div>

            {/* Connector marquee */}
            <div className="reveal w-full overflow-hidden">
              <div className="marquee-container flex flex-col gap-4">
                {/* Row 1 - scrolls left */}
                <div className="marquee-track">
                  <div className="marquee-scroll flex gap-3.5">
                    {[...CONNECTORS_ROW1, ...CONNECTORS_ROW1].map(
                      (connector, i) => {
                        return (
                          <div
                            key={`${connector.name}-${i}`}
                            className="connector-card flex shrink-0 items-center gap-3.5 rounded-[22.4px] border border-[hsl(var(--gray-200))] bg-white p-3.5"
                          >
                            {connector.darkIcon ? (
                              <>
                                <Image
                                  src={connector.icon}
                                  alt={connector.name}
                                  width={34}
                                  height={34}
                                  className="h-[34px] w-[34px] shrink-0 light-only"
                                />
                                <Image
                                  src={connector.darkIcon}
                                  alt={connector.name}
                                  width={34}
                                  height={34}
                                  className="h-[34px] w-[34px] shrink-0 dark-only"
                                />
                              </>
                            ) : (
                              <Image
                                src={connector.icon}
                                alt={connector.name}
                                width={34}
                                height={34}
                                className={`h-[34px] w-[34px] shrink-0${connector.dark ? " landing-icon-invert" : ""}`}
                              />
                            )}
                            <span className="whitespace-nowrap text-[19.6px] font-medium leading-7 text-[hsl(var(--foreground))]">
                              {connector.name}
                            </span>
                          </div>
                        );
                      },
                    )}
                  </div>
                </div>
                {/* Row 2 - scrolls right */}
                <div className="marquee-track">
                  <div className="marquee-scroll marquee-reverse flex gap-3.5">
                    {[...CONNECTORS_ROW2, ...CONNECTORS_ROW2].map(
                      (connector, i) => {
                        return (
                          <div
                            key={`${connector.name}-${i}`}
                            className="connector-card flex shrink-0 items-center gap-3.5 rounded-[22.4px] border border-[hsl(var(--gray-200))] bg-white p-3.5"
                          >
                            {connector.darkIcon ? (
                              <>
                                <Image
                                  src={connector.icon}
                                  alt={connector.name}
                                  width={34}
                                  height={34}
                                  className="h-[34px] w-[34px] shrink-0 light-only"
                                />
                                <Image
                                  src={connector.darkIcon}
                                  alt={connector.name}
                                  width={34}
                                  height={34}
                                  className="h-[34px] w-[34px] shrink-0 dark-only"
                                />
                              </>
                            ) : (
                              <Image
                                src={connector.icon}
                                alt={connector.name}
                                width={34}
                                height={34}
                                className={`h-[34px] w-[34px] shrink-0${connector.dark ? " landing-icon-invert" : ""}`}
                              />
                            )}
                            <span className="whitespace-nowrap text-[19.6px] font-medium leading-7 text-[hsl(var(--foreground))]">
                              {connector.name}
                            </span>
                          </div>
                        );
                      },
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===== SECURITY SECTION ===== */}
        <section className="px-5 py-10 sm:px-6 sm:py-12 md:py-16">
          <div className="mx-auto max-w-[1152px]">
            <div className="reveal">
              <h2 className="landing-heading text-center text-[28px] font-medium leading-[1.2] tracking-[-0.88px] text-[hsl(var(--foreground))] sm:text-[34px] md:text-[40px]">
                {t("security.heading")}
              </h2>
            </div>

            <div className="reveal mt-14 flex flex-col gap-6 md:flex-row">
              {/* Permission management card */}
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-white">
                <div className="flex flex-1 flex-col gap-4 p-10">
                  <h3 className="text-2xl font-medium leading-8 text-[hsl(var(--foreground))]">
                    {t("security.permissionTitle")}
                  </h3>
                  <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
                    {t("security.permissionDesc")}
                  </p>
                </div>
                <div className="flex h-[300px] items-center justify-center rounded-b-[20px] bg-[hsl(var(--gray-100))] px-10">
                  <Image
                    alt="Permission management interface"
                    src="/assets/mockup/permission-management.svg"
                    width={448}
                    height={300}
                    className="w-full max-w-[448px]"
                    draggable={false}
                    unoptimized
                  />
                </div>
              </div>

              {/* Secure by design card */}
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-white">
                <div className="flex flex-col gap-4 p-10">
                  <h3 className="text-2xl font-medium leading-8 text-[hsl(var(--foreground))]">
                    {t("security.isolatedTitle")}
                  </h3>
                  <p className="min-h-[72px] text-base leading-6 text-[hsl(var(--muted-foreground))]">
                    {t("security.isolatedDescPart1")}
                    <a
                      href="https://github.com/vm0-ai/vm0"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-[#45A7A8] underline underline-offset-2 hover:text-[#3a8e8f]"
                    >
                      {t("security.isolatedDescLink")}
                    </a>
                    {t("security.isolatedDescPart2")}
                  </p>
                </div>
                <div className="flex h-[300px] items-center justify-center rounded-b-[20px] bg-[hsl(var(--gray-100))] px-10">
                  <CubeShieldIllustration />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===== AGENT INTELLIGENCE SECTION ===== */}
        <section className="px-5 py-10 sm:px-6 sm:py-12 md:py-16">
          <div className="mx-auto flex max-w-[1152px] flex-col items-center gap-14">
            {/* Section title */}
            <div className="reveal">
              <h2 className="landing-heading max-w-[740px] text-center text-[28px] font-medium leading-[1.2] tracking-[-0.88px] text-[hsl(var(--foreground))] sm:text-[34px] md:text-[40px]">
                {t("intelligence.heading")}
              </h2>
            </div>

            {/* Two large cards */}
            <div className="reveal grid w-full gap-6 md:grid-cols-2">
              {/* Persistent memory card */}
              <div className="flex h-full flex-col overflow-hidden rounded-[20px] bg-white">
                <div className="flex flex-col gap-4 px-8 pb-6 pt-8 sm:px-10 sm:pt-10">
                  <h3 className="text-2xl font-medium leading-8 text-[hsl(var(--foreground))]">
                    {t("intelligence.memoryTitle")}
                  </h3>
                  <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
                    {t("intelligence.memoryDesc")}
                  </p>
                </div>
                <MemoryMockupArea />
              </div>

              {/* Scheduled intelligence card */}
              <div className="flex h-full flex-col overflow-hidden rounded-[20px] bg-white">
                <div className="flex flex-col gap-4 px-8 pb-6 pt-8 sm:px-10 sm:pt-10">
                  <h3 className="text-2xl font-medium leading-8 text-[hsl(var(--foreground))]">
                    {t("intelligence.scheduleTitle")}
                  </h3>
                  <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
                    {t("intelligence.scheduleDesc")}
                  </p>
                </div>
                <ScheduleMockupArea />
              </div>
            </div>

            {/* Three bottom benefit items */}
            <div className="reveal grid w-full gap-8 sm:grid-cols-3">
              {(
                [
                  {
                    titleKey: "intelligence.subAgentsTitle",
                    descKey: "intelligence.subAgentsDesc",
                  },
                  {
                    titleKey: "intelligence.toolOrchTitle",
                    descKey: "intelligence.toolOrchDesc",
                  },
                  {
                    titleKey: "intelligence.identityTitle",
                    descKey: "intelligence.identityDesc",
                  },
                ] as const
              ).map((item) => {
                return (
                  <div key={item.titleKey} className="flex flex-col gap-2">
                    <h3 className="text-base font-bold leading-6 text-[hsl(var(--foreground))]">
                      {t(item.titleKey)}
                    </h3>
                    <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
                      {t(item.descKey)}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ===== COMPARISON SECTION ===== */}
        <section className="px-5 py-10 sm:px-6 sm:py-12 md:py-16">
          <div className="mx-auto max-w-[1152px]">
            <div className="reveal flex flex-col items-center">
              <h2 className="landing-heading text-center text-[22px] font-medium leading-[1.2] tracking-[-0.88px] text-[hsl(var(--foreground))] sm:text-[28px] md:whitespace-nowrap md:text-[36px]">
                {t("comparison.heading")}
              </h2>
            </div>

            <div className="mt-12 grid gap-6 sm:mt-16 md:grid-cols-2">
              {COMPARISON_ITEMS.map((item) => {
                return (
                  <div
                    key={item.key}
                    className="reveal flex flex-col gap-3 rounded-[20px] bg-white p-8 sm:p-10"
                  >
                    <div className="flex items-center gap-3">
                      <CompetitorIcon item={item} />
                      <span className="text-[11px] font-semibold uppercase tracking-[1.5px] text-[#ed4e01]">
                        {t(`comparison.${item.key}.label`)}
                      </span>
                    </div>
                    <h3 className="text-xl font-medium leading-7 text-[hsl(var(--foreground))] sm:text-2xl sm:leading-8">
                      {t(`comparison.${item.key}.heading`)}
                    </h3>
                    <p className="text-[15px] leading-6 text-[hsl(var(--muted-foreground))]">
                      {t(`comparison.${item.key}.body`)}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ===== CTA SECTION ===== */}
        <section className="px-5 pb-10 pt-2 sm:px-6 sm:pb-12 md:pb-16">
          <div className="mx-auto max-w-[1152px]">
            <div className="flex flex-col items-start gap-6 rounded-[20px] bg-white px-6 py-8 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:px-10">
              <div className="flex flex-col gap-2">
                <h3 className="landing-heading text-[22px] font-medium leading-[1.3] tracking-[-0.5px] text-[hsl(var(--foreground))] sm:text-[26px]">
                  {t("cta.title")}
                </h3>
                <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
                  {t("cta.subtitle")}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4">
                <CtaButton
                  isSignedIn={isSignedIn ?? false}
                  ctaText={ctaText}
                  ctaHref={ctaHref}
                  className="shrink-0"
                />
                <AddToSlackButton />
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
