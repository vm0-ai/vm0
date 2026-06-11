"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  IconChevronRight,
  IconExternalLink,
  IconPalette,
  IconPlus,
  IconRefresh,
  IconSparkles,
} from "@tabler/icons-react";
import { CopyablePrompt } from "../../components/CopyablePrompt";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
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

const CONTAINER = "mx-auto w-full max-w-[1120px] px-6";
const BTN_PRIMARY =
  "inline-flex h-[46px] items-center justify-center gap-2 rounded-[10px] bg-[#ed4e01] px-[22px] text-[15px] font-semibold text-white transition-colors hover:bg-[#d94600]";
const BTN_GHOST =
  "inline-flex h-[46px] items-center justify-center gap-2 rounded-[10px] border border-[hsl(var(--border))] bg-white px-[22px] text-[15px] font-semibold text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--gray-0))]";
const EYEBROW =
  "text-[13px] font-bold uppercase tracking-[0.06em] text-[#ed4e01]";
const H2 =
  "landing-heading mt-3 text-[clamp(28px,3.6vw,40px)] font-extrabold leading-[1.1] tracking-[-0.025em]";
const LEAD =
  "mx-auto mt-4 max-w-[620px] text-[17px] leading-relaxed text-[hsl(var(--muted-foreground))]";

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
    icon: IconSparkles,
    title: "One shot, great result",
    body: "A single prompt produces a polished, presentation-ready deck on the first try — structured narrative, real layouts, beautifully designed visuals. Most decks need zero cleanup before you present.",
  },
  {
    icon: IconPalette,
    title: "A rich template library",
    body: "60+ beautifully crafted design systems plus a growing set of deck templates — pitch decks, product launches, tech talks, weekly reports, course modules. Pick one and you're already halfway there.",
  },
  {
    icon: IconRefresh,
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

function Hero({ startHref }: { startHref: string }) {
  return (
    <section className="border-b border-[hsl(var(--border))] bg-gradient-to-b from-white via-[hsl(var(--gray-0))] to-[hsl(var(--gray-0))]">
      <div className={`${CONTAINER} pb-16 pt-[78px] text-center`}>
        <span className="inline-flex items-center gap-2 rounded-full border border-[#f3d6c4] bg-white px-3.5 py-1.5 text-[13px] font-semibold text-[#ed4e01]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#ed4e01]" />
          AI Presentation Maker
        </span>
        <h1 className="landing-heading mx-auto mt-5 max-w-[820px] text-[clamp(34px,5.2vw,58px)] font-extrabold leading-[1.06] tracking-[-0.03em]">
          Turn one prompt into a{" "}
          <span className="text-[#ed4e01]">presentation-ready</span> deck
        </h1>
        <p className="mx-auto mt-5 max-w-[640px] text-[clamp(16px,2vw,20px)] text-[hsl(var(--muted-foreground))]">
          Describe your topic and VM0 builds a polished, beautifully designed
          slide deck in minutes — crafted with 60+ world-class design systems.
          No design skills, no templates to wrestle, no wasted afternoons.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <a href={startHref} className={BTN_PRIMARY}>
            <IconSparkles size={17} stroke={2} />
            Generate my deck
          </a>
          <a href="#showcase" className={BTN_GHOST}>
            Browse 100+ examples
          </a>
        </div>
        <p className="mt-4 text-[13.5px] text-[hsl(var(--muted-foreground))]">
          Editable output · Export to PPTX, PDF &amp; HTML · Free to start
        </p>
        <HeroDeck />
      </div>
    </section>
  );
}

function HeroDeck() {
  const slides = PRESENTATION_ITEMS.slice(0, 6);

  return (
    <div className="mx-auto mt-14 max-w-[900px]" style={{ perspective: 1600 }}>
      <div
        className="overflow-hidden rounded-[14px] border border-[hsl(var(--border))] bg-white shadow-[0_30px_70px_-30px_rgba(40,30,20,0.4)]"
        style={{ transform: "rotateX(4deg)" }}
      >
        <div className="flex items-center gap-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--gray-0))] px-3.5 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-[#dcd4c9]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#dcd4c9]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#dcd4c9]" />
        </div>
        <div className="grid grid-cols-2 gap-3.5 p-4 sm:grid-cols-3">
          {slides.map((item) => {
            return (
              <div
                key={item.slug}
                className="relative aspect-[16/9] overflow-hidden rounded-[8px] border border-[hsl(var(--border))] bg-[hsl(var(--gray-0))]"
              >
                <Image
                  src={item.previewImage}
                  alt={item.title}
                  fill
                  sizes="(min-width: 640px) 280px, 45vw"
                  className="object-cover"
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BrandStrip() {
  return (
    <div className="border-b border-[hsl(var(--border))] bg-white py-10">
      <div className={CONTAINER}>
        <p className="text-center text-[13px] font-semibold uppercase tracking-[0.04em] text-[hsl(var(--muted-foreground))]">
          Beautifully designed with 60+ world-class design systems
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-3.5">
          {BRAND_CHIPS.map((name) => {
            return (
              <span
                key={name}
                className="text-[16px] font-bold tracking-[-0.01em] text-[#b3aaa0]"
              >
                {name}
              </span>
            );
          })}
        </div>
      </div>
    </div>
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
    <div
      className={`grid items-center gap-14 py-[52px] md:grid-cols-2 ${
        index === 0 ? "" : "border-t border-[hsl(var(--border))]"
      }`}
    >
      <div className={flip ? "md:order-2" : ""}>
        <span className={EYEBROW}>{section.eyebrow}</span>
        <h3 className="landing-heading mt-3 text-[clamp(24px,3vw,33px)] font-extrabold leading-[1.12] tracking-[-0.025em]">
          {section.title}
        </h3>
        <p className="mt-3.5 text-[16.5px] text-[hsl(var(--muted-foreground))]">
          {section.body}
        </p>
        <ul className="mt-5 flex flex-col gap-2.5">
          {section.points.map((point) => {
            return (
              <li
                key={point}
                className="flex gap-2.5 text-[15px] text-[hsl(var(--muted-foreground))]"
              >
                <span className="font-extrabold text-[#ed4e01]">✓</span>
                {point}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="flex min-h-[230px] flex-col justify-center gap-4 rounded-[16px] border border-[hsl(var(--border))] bg-gradient-to-b from-white to-[hsl(var(--gray-0))] p-7">
        <div className="text-[50px] font-extrabold leading-none tracking-[-0.03em] text-[#ed4e01]">
          {section.stat}
          <span className="mt-2.5 block text-[14px] font-medium tracking-normal text-[hsl(var(--muted-foreground))]">
            {section.statLabel}
          </span>
        </div>
      </div>
    </div>
  );
}

function WhyDeck() {
  return (
    <section id="why" className="bg-white py-[88px]">
      <div className={CONTAINER}>
        <div className="text-center">
          <p className={EYEBROW}>Why VM0 deck</p>
          <h2 className={H2}>Why teams choose VM0 over a deck template</h2>
          <p className={LEAD}>
            A template hands you empty boxes to fill in. VM0 hands you a
            finished, beautifully designed deck — done for you.
          </p>
        </div>
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
    <section id="features" className={`${CONTAINER} py-[88px]`}>
      <div className="text-center">
        <p className={EYEBROW}>Features</p>
        <h2 className={H2}>What makes VM0 decks different</h2>
        <p className={LEAD}>
          Most AI slide tools make you fix the output slide by slide. VM0 nails
          the whole deck in one shot — then hands you a huge library to start
          from.
        </p>
      </div>
      <div className="mt-[52px] grid gap-[22px] md:grid-cols-3">
        {FEATURES.map((feature) => {
          const Icon = feature.icon;
          return (
            <div
              key={feature.title}
              className="rounded-[16px] border border-[hsl(var(--border))] bg-[hsl(var(--gray-0))] p-7"
            >
              <div className="mb-[18px] flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-[hsl(var(--border))] bg-white text-[#ed4e01]">
                <Icon size={22} stroke={2} />
              </div>
              <h3 className="text-[19px] font-bold tracking-[-0.01em]">
                {feature.title}
              </h3>
              <p className="mt-2.5 text-[15px] text-[hsl(var(--muted-foreground))]">
                {feature.body}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" className={`${CONTAINER} pb-[88px]`}>
      <div className="text-center">
        <p className={EYEBROW}>How it works</p>
        <h2 className={H2}>From idea to deck in three steps</h2>
      </div>
      <div className="mt-[52px] grid gap-9 md:grid-cols-3">
        {STEPS.map((step, index) => {
          return (
            <div
              key={step.title}
              className="md:border-l md:border-[hsl(var(--border))] md:pl-7 md:first:border-l-0 md:first:pl-0"
            >
              <div className="mb-[18px] flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#ed4e01] text-[17px] font-extrabold text-white">
                {index + 1}
              </div>
              <h3 className="text-[19px] font-bold">{step.title}</h3>
              <p className="mt-2.5 text-[15px] text-[hsl(var(--muted-foreground))]">
                {step.body}
              </p>
              {step.code ? (
                <code className="mt-3 inline-block rounded-[5px] border border-[hsl(var(--border))] bg-[hsl(var(--gray-0))] px-1.5 py-0.5 font-mono text-[12.5px]">
                  {step.code}
                </code>
              ) : null}
            </div>
          );
        })}
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
    <article className="overflow-hidden rounded-[14px] border border-[hsl(var(--border))] bg-white transition-all duration-300 hover:-translate-y-[3px] hover:shadow-[0_18px_40px_-18px_rgba(40,30,20,0.35)]">
      <a
        href={item.embedUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`View ${item.title} in a new tab`}
        className="group block"
      >
        <div className="relative aspect-[16/9] overflow-hidden bg-[hsl(var(--gray-0))]">
          <Image
            src={item.previewImage}
            alt={item.title}
            fill
            sizes="(min-width: 880px) 360px, calc(100vw - 48px)"
            className="object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/35 group-hover:opacity-100">
            <span className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-2 text-[13px] font-medium text-[hsl(var(--foreground))] shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
              <IconExternalLink size={16} stroke={2} />
              View
            </span>
          </div>
        </div>
      </a>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="text-[15px] font-bold leading-tight">{item.title}</div>
        <CopyablePrompt prompt={item.prompt} />
        <a href={remixHref} className={`${BTN_PRIMARY} h-9 px-3.5 text-[14px]`}>
          <IconSparkles size={15} stroke={2} />
          Try it
        </a>
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
    <section
      id="showcase"
      className="border-y border-[hsl(var(--border))] bg-[hsl(var(--gray-0))] py-[88px]"
    >
      <div className={CONTAINER}>
        <div className="text-center">
          <p className={EYEBROW}>Showcase</p>
          <h2 className={H2}>Decks made with a single prompt</h2>
          <p className={LEAD}>
            Copy any prompt, click <strong>Try it</strong>, and remix it into
            your own deck.
          </p>
        </div>
        <div className="mt-9 flex flex-wrap justify-center gap-2.5">
          {chips.map((chip) => {
            const isActive = chip === active;
            return (
              <button
                key={chip}
                type="button"
                onClick={() => {
                  setActive(chip);
                }}
                className={`rounded-full border px-4 py-2 text-[13.5px] font-semibold transition-colors ${
                  isActive
                    ? "border-[hsl(var(--foreground))] bg-[hsl(var(--foreground))] text-white"
                    : "border-[hsl(var(--border))] bg-white text-[hsl(var(--muted-foreground))] hover:border-[#d8d1c7]"
                }`}
              >
                {chip}
              </button>
            );
          })}
        </div>
        <div className="mt-9 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
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
    <section id="usecases" className={`${CONTAINER} py-[88px]`}>
      <div className="text-center">
        <p className={EYEBROW}>Use cases</p>
        <h2 className={H2}>One maker, every kind of deck</h2>
      </div>
      <div className="mt-12 grid gap-[18px] md:grid-cols-3">
        {USE_CASES.map((useCase) => {
          return (
            <div
              key={useCase.title}
              className="rounded-[13px] border border-[hsl(var(--border))] bg-white p-6 transition-colors hover:border-[#d8d1c7]"
            >
              <div className="mb-3 text-[24px]">{useCase.icon}</div>
              <h3 className="text-[16.5px] font-bold">{useCase.title}</h3>
              <p className="mt-1.5 text-[14px] text-[hsl(var(--muted-foreground))]">
                {useCase.body}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Comparison() {
  return (
    <section className={`${CONTAINER} pb-[88px]`}>
      <div className="text-center">
        <p className={EYEBROW}>Compare</p>
        <h2 className={H2}>Built for decks you&apos;d actually present</h2>
      </div>
      <div className="mx-auto mt-12 max-w-[760px] overflow-hidden rounded-[16px] border border-[hsl(var(--border))]">
        <table className="w-full border-collapse text-[15px]">
          <thead>
            <tr className="bg-[hsl(var(--gray-0))] text-[13px] uppercase tracking-[0.03em] text-[hsl(var(--muted-foreground))]">
              <th className="border-b border-[hsl(var(--border))] px-[18px] py-3.5 text-left font-bold">
                Capability
              </th>
              <th className="border-b border-[hsl(var(--border))] px-[18px] py-3.5 text-left font-bold text-[#ed4e01]">
                VM0
              </th>
              <th className="border-b border-[hsl(var(--border))] px-[18px] py-3.5 text-left font-bold">
                Generic AI slide tools
              </th>
            </tr>
          </thead>
          <tbody>
            {COMPARISON_ROWS.map((row, index) => {
              const last = index === COMPARISON_ROWS.length - 1;
              const cell = last
                ? "px-[18px] py-3.5 text-left"
                : "border-b border-[hsl(var(--border))] px-[18px] py-3.5 text-left";
              return (
                <tr key={row[0]}>
                  <td className={cell}>{row[0]}</td>
                  <td className={`${cell} font-bold text-[#ed4e01]`}>
                    {row[1]}
                  </td>
                  <td className={`${cell} text-[hsl(var(--muted-foreground))]`}>
                    {row[2]}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section id="faq" className={`${CONTAINER} py-[88px]`}>
      <div className="text-center">
        <p className={EYEBROW}>FAQ</p>
        <h2 className={H2}>Frequently asked questions</h2>
      </div>
      <div className="mx-auto mt-12 max-w-[760px]">
        {PRESENTATION_FAQS.map((faq) => {
          return (
            <details
              key={faq.question}
              className="group mb-3 overflow-hidden rounded-[12px] border border-[hsl(var(--border))] bg-white"
            >
              <summary className="flex cursor-pointer items-center justify-between gap-4 px-[22px] py-5 text-[16.5px] font-semibold [&::-webkit-details-marker]:hidden">
                {faq.question}
                <IconPlus
                  size={20}
                  stroke={2.5}
                  className="shrink-0 text-[#ed4e01] transition-transform group-open:rotate-45"
                />
              </summary>
              <div className="px-[22px] pb-5 text-[15px] text-[hsl(var(--muted-foreground))]">
                {faq.answer}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function FinalCta({ startHref }: { startHref: string }) {
  return (
    <section className="bg-[#16130f] text-white">
      <div className={`${CONTAINER} py-20 text-center`}>
        <h2 className="landing-heading text-[clamp(28px,3.6vw,40px)] font-extrabold leading-[1.1] tracking-[-0.025em]">
          Your next deck is one prompt away
        </h2>
        <p className="mx-auto mt-4 max-w-[520px] text-[17px] text-[#cfc7bc]">
          Stop fighting templates. Describe what you need and let VM0 design it
          — beautifully, on time.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <a href={startHref} className={BTN_PRIMARY}>
            <IconSparkles size={17} stroke={2} />
            Generate my deck
          </a>
          <a
            href="#showcase"
            className="inline-flex h-[46px] items-center justify-center gap-2 rounded-[10px] border border-[#3a352e] bg-transparent px-[22px] text-[15px] font-semibold text-white transition-colors hover:bg-[#241f1a]"
          >
            See examples
            <IconChevronRight size={17} stroke={2} />
          </a>
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
    <div className="landing-page min-h-screen bg-white text-[hsl(var(--foreground))]">
      <Particles />
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
      <Footer />
    </div>
  );
}
