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
        <Showcase appUrl={appUrl} landingSearch={landingSearch} />
        <Features />
        <HowItWorks />
        <Faq />
        <FinalCta startHref={startHref} />
      </main>
      <Footer />
    </div>
  );
}
