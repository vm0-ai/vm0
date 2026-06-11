"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { IconExternalLink, IconSparkles } from "@tabler/icons-react";
import { CopyablePrompt } from "../../components/CopyablePrompt";
import { Footer } from "../../components/Footer";
import { getAppUrl } from "../../../src/lib/zero/url";
import {
  buildPresentationRemixHref,
  buildPresentationStartHref,
  getPresentationCategory,
  PRESENTATION_CATEGORIES,
  PRESENTATION_FAQS,
  PRESENTATION_ITEMS,
  type PresentationCategory,
  type PresentationItem,
} from "./data";

const SECTION = "px-5 py-10 sm:px-6 sm:py-12 md:py-16";
const CONTAINER = "mx-auto max-w-[1152px]";
const EYEBROW =
  "text-[11px] font-semibold uppercase tracking-[1.5px] text-[#ed4e01]";
const H2_CLASS =
  "landing-heading text-[28px] font-medium leading-[1.2] tracking-[-0.88px] text-[hsl(var(--foreground))] sm:text-[34px] md:text-[40px]";
const LEAD =
  "text-[16px] leading-7 text-[hsl(var(--muted-foreground))] sm:text-[18px]";
const BODY = "text-base leading-6 text-[hsl(var(--muted-foreground))]";
const CARD = "rounded-[20px] bg-white";
const CTA_STYLE = {
  background: "#ed4e01",
  boxShadow: "inset 0 -2px 0 #a33703",
  color: "#ffffff",
} as const;
const SECONDARY_CTA =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-[hsl(var(--gray-300))] px-6 py-3 text-base font-medium text-[hsl(var(--foreground))] transition-all hover:bg-[hsl(var(--gray-100))]";

function PrimaryCta({
  href,
  children,
  small,
}: {
  href: string;
  children: React.ReactNode;
  small?: boolean;
}) {
  const cls = small
    ? "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl px-5 py-2.5 text-sm font-medium transition-all hover:bg-[#ff6a1f]"
    : "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl px-8 py-3.5 text-base font-medium transition-all hover:bg-[#ff6a1f] sm:px-14";
  return (
    <a href={href} className={cls} style={CTA_STYLE}>
      {children}
    </a>
  );
}

function SectionHead({
  eyebrow,
  title,
  lead,
}: {
  eyebrow: string;
  title: string;
  lead?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <span className={EYEBROW}>{eyebrow}</span>
      <h2 className={`text-center ${H2_CLASS}`}>{title}</h2>
      {lead ? <p className={`max-w-[680px] ${LEAD}`}>{lead}</p> : null}
    </div>
  );
}

const BRAND_CHIPS = [
  "SpaceX",
  "Apple",
  "Tesla",
  "Stripe",
  "Nvidia",
  "Linear",
  "Notion",
  "Vercel",
  "Shopify",
  "Anthropic",
  "Airbnb",
  "+ 50 more",
];

const FEATURES = [
  {
    icon: "🎯",
    title: "One shot, great result",
    body: "A single prompt produces a polished, presentation-ready deck on the first try — structured narrative, real layouts, beautifully designed visuals. Most decks need zero cleanup before you present.",
  },
  {
    icon: "🎨",
    title: "A rich template library",
    body: "60+ beautifully crafted design systems plus a growing set of deck templates — pitch decks, product launches, tech talks, weekly reports, course modules. Pick one and you're already halfway there.",
  },
  {
    icon: "🔁",
    title: "Decks that refresh themselves",
    body: "Set a recurring deck — a weekly team report, a monthly board update — and Zero regenerates it on schedule with fresh data, beautifully designed, ready when you are. The only slide maker that's also an AI teammate.",
  },
];

const STEPS = [
  {
    title: "Describe your deck",
    body: "One sentence is enough: topic, audience, and the style you want.",
    code: "a pitch deck for a fintech seed round",
  },
  {
    title: "VM0 designs it",
    body: "Zero writes the narrative, builds the slides, picks the layout, and renders charts in your chosen design system — autonomously.",
  },
  {
    title: "Refine & export",
    body: "Edit any slide, regenerate sections by prompt, then download as PPTX, PDF, or HTML and present.",
  },
];

const USE_CASES = [
  {
    icon: "🚀",
    title: "Startup pitch decks",
    body: "Fundable narrative, market sizing, and traction slides — investor-ready in minutes.",
  },
  {
    icon: "📣",
    title: "Product launches",
    body: "Keynote-grade reveals with feature walkthroughs and go-to-market plans.",
  },
  {
    icon: "📈",
    title: "Investor & board updates",
    body: "Recurring metrics, KPI charts, and milestone recaps in a consistent house style.",
  },
  {
    icon: "🎓",
    title: "Course & training modules",
    body: "Lesson decks with clear structure, diagrams, and recap slides for any topic.",
  },
  {
    icon: "🧠",
    title: "Tech talks & sharing",
    body: "Architecture diagrams, code walkthroughs, and benchmark comparisons that read clearly.",
  },
  {
    icon: "🗓️",
    title: "Weekly team reports",
    body: "Shipped / metrics / next-up summaries generated on a schedule, automatically.",
  },
];

const COMPARISON_ROWS = [
  ["Beautifully crafted design systems", "60+ built-in", "Basic templates"],
  ["Real charts & infographics", "Yes", "Often placeholder boxes"],
  ["Full deck from one prompt", "Yes", "Slide-by-slide"],
  ["Editable + PPTX / PDF / HTML export", "All three", "Usually PPTX only"],
  ["Scheduled, recurring decks", "Yes", "No"],
];

const WHY_SECTIONS = [
  {
    eyebrow: "01 — Speed",
    title: "Minutes, not afternoons",
    body: "Stop rebuilding the same slide master, hunting for icons, and nudging text boxes. Describe the deck in one line and VM0 writes the narrative, builds every slide, and lays it out — while you'd still be opening the template.",
    points: [
      "One-sentence brief in, full deck out",
      "Regenerate any section with a follow-up prompt",
      "No slide master, no manual formatting",
    ],
    stat: "~3 min",
    statLabel: "from prompt to a presentation-ready deck",
  },
  {
    eyebrow: "02 — Design",
    title: "Beautifully designed, every single slide",
    body: "Every slide is crafted, not just filled in — considered layout, type scale, color, and spacing, so the whole deck looks like a senior designer made it. Choose from 60+ world-class design systems, or bring your own look.",
    points: [
      "60+ beautifully crafted design systems",
      "Bring your own colors, fonts, and logo",
      "Consistent type, color, and spacing throughout",
    ],
    stat: "60+",
    statLabel: "beautifully crafted design systems",
  },
  {
    eyebrow: "03 — Ownership",
    title: "Edit it, own it, export it anywhere",
    body: "The generated deck is yours. Tweak any slide in the live editor, then export to the format your audience needs — no watermark, no lock-in. And set it to regenerate on a schedule for recurring reports.",
    points: [
      "Live slide editor — change anything",
      "No watermark, no vendor lock-in",
      "Recurring decks on a schedule",
    ],
    stat: "3 formats",
    statLabel: "PPTX · PDF · HTML",
  },
];

function BackgroundOverlays() {
  return (
    <>
      <svg
        className="landing-noise pointer-events-none fixed inset-0 z-0 h-full w-full opacity-[0.018]"
        aria-hidden="true"
      >
        <filter id="presentation-noise">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.8"
            numOctaves="4"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#presentation-noise)" />
      </svg>
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
    </>
  );
}

function Hero({ startHref }: { startHref: string }) {
  return (
    <section className="relative px-5 pt-[var(--total-header-height,80px)] sm:px-6">
      <div className="relative z-10 mx-auto flex max-w-[860px] flex-col items-center gap-6 pb-4 pt-[80px] text-center sm:pt-[110px]">
        <span className={EYEBROW}>AI Presentation Maker</span>
        <h1 className="landing-heading w-full text-[32px] font-medium leading-[1.4] tracking-[-1.12px] text-[hsl(var(--foreground))] sm:text-[42px] md:text-[51px]">
          Turn one prompt into a{" "}
          <span className="text-[#ed4e01]">presentation-ready</span> deck
        </h1>
        <p className={`max-w-[640px] ${LEAD}`}>
          Describe your topic and VM0 builds a polished, beautifully designed
          slide deck in minutes — crafted with 60+ world-class design systems.
          No design skills, no templates to wrestle, no wasted afternoons.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <PrimaryCta href={startHref}>
            <IconSparkles size={17} stroke={2} />
            Generate my deck
          </PrimaryCta>
          <a href="#showcase" className={SECONDARY_CTA}>
            Browse 100+ examples
          </a>
        </div>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          Editable output · Export to PPTX, PDF &amp; HTML · Free to start
        </p>
      </div>
      <div className="relative z-10 mx-auto max-w-[960px] pb-4">
        <HeroDeck />
      </div>
    </section>
  );
}

function HeroDeck() {
  const slides = PRESENTATION_ITEMS.slice(0, 6);

  return (
    <div
      className={`overflow-hidden ${CARD} shadow-[0px_1.6px_101px_40px_rgba(0,0,0,0.06)]`}
    >
      <div className="flex items-center gap-2 border-b border-[hsl(var(--gray-200))] px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[hsl(var(--gray-300))]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[hsl(var(--gray-300))]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[hsl(var(--gray-300))]" />
      </div>
      <div className="grid grid-cols-2 gap-3.5 p-4 sm:grid-cols-3 sm:p-6">
        {slides.map((item) => {
          return (
            <div
              key={item.slug}
              className="relative aspect-[16/9] overflow-hidden rounded-[10px] bg-[hsl(var(--gray-100))]"
            >
              <Image
                src={item.previewImage}
                alt={item.title}
                fill
                sizes="(min-width: 640px) 300px, 45vw"
                className="object-cover"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BrandStrip() {
  return (
    <section className="px-5 py-8 sm:px-6">
      <div className={`${CONTAINER} flex flex-col items-center gap-5`}>
        <p className="text-center text-[11px] font-semibold uppercase tracking-[1.5px] text-[hsl(var(--muted-foreground))]">
          Beautifully designed with 60+ world-class design systems
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3.5">
          {BRAND_CHIPS.map((name) => {
            return (
              <span
                key={name}
                className="text-[16px] font-medium text-[hsl(var(--gray-400))]"
              >
                {name}
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function WhySection({
  section,
  index,
}: {
  section: (typeof WHY_SECTIONS)[number];
  index: number;
}) {
  const flip = index % 2 === 1;

  return (
    <div className="grid items-center gap-8 md:grid-cols-2 md:gap-12">
      <div className={flip ? "md:order-2" : ""}>
        <span className={EYEBROW}>{section.eyebrow}</span>
        <h3 className="landing-heading mt-3 text-[24px] font-medium leading-[1.2] tracking-[-0.5px] text-[hsl(var(--foreground))] sm:text-[28px]">
          {section.title}
        </h3>
        <p className={`mt-4 ${BODY}`}>{section.body}</p>
        <ul className="mt-5 flex flex-col gap-2.5">
          {section.points.map((point) => {
            return (
              <li
                key={point}
                className="flex gap-2.5 text-base text-[hsl(var(--muted-foreground))]"
              >
                <span className="font-semibold text-[#ed4e01]">✓</span>
                {point}
              </li>
            );
          })}
        </ul>
      </div>
      <div
        className={`flex min-h-[220px] flex-col justify-center p-8 sm:p-10 ${CARD}`}
      >
        <div className="landing-heading text-[48px] font-medium leading-none tracking-[-1.5px] text-[#ed4e01]">
          {section.stat}
        </div>
        <p className="mt-3 text-base text-[hsl(var(--muted-foreground))]">
          {section.statLabel}
        </p>
      </div>
    </div>
  );
}

function WhyDeck() {
  return (
    <section id="why" className={SECTION}>
      <div className={`${CONTAINER} flex flex-col gap-12 sm:gap-16`}>
        <SectionHead
          eyebrow="Why VM0 deck"
          title="Why teams choose VM0 over a deck template"
          lead="A template hands you empty boxes to fill in. VM0 hands you a finished, beautifully designed deck — done for you."
        />
        {WHY_SECTIONS.map((section, index) => {
          return (
            <WhySection key={section.eyebrow} section={section} index={index} />
          );
        })}
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className={SECTION}>
      <div className={CONTAINER}>
        <SectionHead
          eyebrow="Features"
          title="What makes VM0 decks different"
          lead="Most AI slide tools make you fix the output slide by slide. VM0 nails the whole deck in one shot — then hands you a huge library to start from."
        />
        <div className="mt-12 grid gap-6 sm:mt-16 md:grid-cols-3">
          {FEATURES.map((feature) => {
            return (
              <div key={feature.title} className={`p-8 ${CARD}`}>
                <div className="flex h-12 w-12 items-center justify-center rounded-[12px] bg-[hsl(var(--gray-100))] text-[24px]">
                  {feature.icon}
                </div>
                <h3 className="mt-5 text-xl font-medium leading-7 text-[hsl(var(--foreground))]">
                  {feature.title}
                </h3>
                <p className={`mt-2.5 ${BODY}`}>{feature.body}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" className={SECTION}>
      <div className={CONTAINER}>
        <SectionHead
          eyebrow="How it works"
          title="From idea to deck in three steps"
        />
        <div className="mt-12 grid gap-6 sm:mt-16 md:grid-cols-3">
          {STEPS.map((step, index) => {
            return (
              <div key={step.title} className={`p-8 ${CARD}`}>
                <div
                  className="flex h-11 w-11 items-center justify-center rounded-[12px] text-[17px] font-medium text-white"
                  style={CTA_STYLE}
                >
                  {index + 1}
                </div>
                <h3 className="mt-5 text-xl font-medium leading-7 text-[hsl(var(--foreground))]">
                  {step.title}
                </h3>
                <p className={`mt-2.5 ${BODY}`}>{step.body}</p>
                {step.code ? (
                  <code className="mt-3 inline-block rounded-lg bg-[hsl(var(--gray-100))] px-2 py-1 font-mono text-[12.5px] text-[hsl(var(--foreground))]">
                    {step.code}
                  </code>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PresentationCard({
  item,
  appUrl,
  landingSearch,
}: {
  item: PresentationItem;
  appUrl: string;
  landingSearch: string;
}) {
  const remixHref = buildPresentationRemixHref(item, appUrl, landingSearch);

  return (
    <article className={`flex flex-col overflow-hidden ${CARD}`}>
      <a
        href={item.embedUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`View ${item.title} in a new tab`}
        className="group block"
      >
        <div className="relative aspect-[16/9] overflow-hidden bg-[hsl(var(--gray-100))]">
          <Image
            src={item.previewImage}
            alt={item.title}
            fill
            sizes="(min-width: 880px) 360px, calc(100vw - 48px)"
            className="object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/35 group-hover:opacity-100">
            <span className="inline-flex items-center gap-2 rounded-xl bg-white px-3.5 py-2 text-[13px] font-medium text-[hsl(var(--foreground))]">
              <IconExternalLink size={16} stroke={2} />
              View
            </span>
          </div>
        </div>
      </a>
      <div className="flex flex-1 flex-col gap-3 px-5 py-4">
        <div className="text-base font-medium leading-6 text-[hsl(var(--foreground))]">
          {item.title}
        </div>
        <CopyablePrompt prompt={item.prompt} />
        <div className="mt-auto">
          <PrimaryCta href={remixHref} small>
            <IconSparkles size={15} stroke={2} />
            Try it
          </PrimaryCta>
        </div>
      </div>
    </article>
  );
}

function Showcase({
  appUrl,
  landingSearch,
}: {
  appUrl: string;
  landingSearch: string;
}) {
  const [active, setActive] = useState<PresentationCategory | "All">("All");

  const visible = useMemo(() => {
    if (active === "All") {
      return PRESENTATION_ITEMS;
    }
    return PRESENTATION_ITEMS.filter((item) => {
      return getPresentationCategory(item) === active;
    });
  }, [active]);

  const chips: ReadonlyArray<PresentationCategory | "All"> = [
    "All",
    ...PRESENTATION_CATEGORIES,
  ];

  return (
    <section id="showcase" className={SECTION}>
      <div className={CONTAINER}>
        <SectionHead
          eyebrow="Showcase"
          title="Decks made with a single prompt"
          lead="Copy any prompt, click Try it, and remix it into your own deck."
        />
        <div className="mt-10 flex flex-wrap justify-center gap-2.5">
          {chips.map((chip) => {
            const isActive = chip === active;
            return (
              <button
                key={chip}
                type="button"
                onClick={() => {
                  setActive(chip);
                }}
                className={
                  isActive
                    ? "rounded-xl px-4 py-2 text-sm font-medium text-white transition-all"
                    : "rounded-xl border border-[hsl(var(--gray-300))] px-4 py-2 text-sm font-medium text-[hsl(var(--foreground))] transition-all hover:bg-[hsl(var(--gray-100))]"
                }
                style={isActive ? CTA_STYLE : undefined}
              >
                {chip}
              </button>
            );
          })}
        </div>
        <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((item) => {
            return (
              <PresentationCard
                key={item.slug}
                item={item}
                appUrl={appUrl}
                landingSearch={landingSearch}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function UseCases() {
  return (
    <section id="usecases" className={SECTION}>
      <div className={CONTAINER}>
        <SectionHead
          eyebrow="Use cases"
          title="One maker, every kind of deck"
        />
        <div className="mt-12 grid gap-6 sm:mt-16 md:grid-cols-3">
          {USE_CASES.map((useCase) => {
            return (
              <div key={useCase.title} className={`p-8 ${CARD}`}>
                <div className="text-[26px]">{useCase.icon}</div>
                <h3 className="mt-4 text-lg font-medium leading-6 text-[hsl(var(--foreground))]">
                  {useCase.title}
                </h3>
                <p className="mt-2 text-base leading-6 text-[hsl(var(--muted-foreground))]">
                  {useCase.body}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Comparison() {
  return (
    <section className={SECTION}>
      <div className={CONTAINER}>
        <SectionHead
          eyebrow="Compare"
          title="Built for decks you actually present"
        />
        <div className={`mx-auto mt-12 max-w-[820px] overflow-hidden ${CARD}`}>
          <table className="w-full border-collapse text-base">
            <thead>
              <tr className="text-[13px] uppercase tracking-[0.5px] text-[hsl(var(--muted-foreground))]">
                <th className="border-b border-[hsl(var(--gray-200))] px-6 py-4 text-left font-semibold">
                  Capability
                </th>
                <th className="border-b border-[hsl(var(--gray-200))] px-6 py-4 text-left font-semibold text-[#ed4e01]">
                  VM0
                </th>
                <th className="border-b border-[hsl(var(--gray-200))] px-6 py-4 text-left font-semibold">
                  Generic AI slide tools
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row, index) => {
                const last = index === COMPARISON_ROWS.length - 1;
                const cell = last
                  ? "px-6 py-4 text-left"
                  : "border-b border-[hsl(var(--gray-200))] px-6 py-4 text-left";
                return (
                  <tr key={row[0]}>
                    <td className={`${cell} text-[hsl(var(--foreground))]`}>
                      {row[0]}
                    </td>
                    <td className={`${cell} font-medium text-[#ed4e01]`}>
                      {row[1]}
                    </td>
                    <td
                      className={`${cell} text-[hsl(var(--muted-foreground))]`}
                    >
                      {row[2]}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section id="faq" className={SECTION}>
      <div className={CONTAINER}>
        <SectionHead eyebrow="FAQ" title="Frequently asked questions" />
        <div className="mx-auto mt-12 flex max-w-[820px] flex-col gap-4">
          {PRESENTATION_FAQS.map((faq) => {
            return (
              <details
                key={faq.question}
                className={`group overflow-hidden ${CARD}`}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-8 py-6 text-lg font-medium text-[hsl(var(--foreground))] [&::-webkit-details-marker]:hidden">
                  {faq.question}
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 14 14"
                    fill="none"
                    aria-hidden="true"
                    className="shrink-0 text-[hsl(var(--foreground)/0.35)] transition-[transform,color] duration-300 group-hover:text-[#ed4e01] group-open:rotate-180"
                  >
                    <path
                      d="M3 5l4 4 4-4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </summary>
                <div className="px-8 pb-6 text-base leading-6 text-[hsl(var(--muted-foreground))]">
                  {faq.answer}
                </div>
              </details>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FinalCta({ startHref }: { startHref: string }) {
  return (
    <section className={SECTION}>
      <div className={CONTAINER}>
        <div
          className={`flex flex-col items-start gap-6 px-6 py-8 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:px-10 ${CARD}`}
        >
          <div>
            <h2 className="landing-heading text-[24px] font-medium leading-[1.2] tracking-[-0.7px] text-[hsl(var(--foreground))] sm:text-[30px]">
              Your next deck is one prompt away
            </h2>
            <p className={`mt-3 ${BODY}`}>
              Stop fighting templates. Describe what you need and let VM0 design
              it — beautifully, on time.
            </p>
          </div>
          <PrimaryCta href={startHref}>
            <IconSparkles size={17} stroke={2} />
            Generate my deck
          </PrimaryCta>
        </div>
      </div>
    </section>
  );
}

export function PresentationClient() {
  const appUrl = getAppUrl();
  const [landingSearch, setLandingSearch] = useState("");

  useEffect(() => {
    setLandingSearch(window.location.search);
  }, []);

  const startHref = buildPresentationStartHref(appUrl, landingSearch);

  return (
    <div className="landing-page relative min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <BackgroundOverlays />
      <main className="relative z-10">
        <Hero startHref={startHref} />
        <BrandStrip />
        <WhyDeck />
        <Features />
        <HowItWorks />
        <Showcase appUrl={appUrl} landingSearch={landingSearch} />
        <UseCases />
        <Comparison />
        <Faq />
        <FinalCta startHref={startHref} />
      </main>
      <Footer />
    </div>
  );
}
