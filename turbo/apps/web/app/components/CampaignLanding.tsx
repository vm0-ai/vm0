"use client";

import { useEffect, useRef, useState } from "react";
import NextLink from "next/link";
import { useUser } from "@clerk/nextjs";
import Image from "next/image";
import { posthog } from "posthog-js";
import { getAppUrl } from "../../src/lib/zero/url";
import { buildSignupHref } from "../../src/lib/adAttribution";
import { Footer } from "./Footer";

// Config-driven paid campaign landing page. Reuses the homepage's design
// tokens, connector marquee, reveal-on-scroll behavior, and the exact
// buildSignupHref attribution path so the trial funnel + Stripe/Clerk
// attribution stay intact. Each paid segment is a pure config object
// (see app/[locale]/<slug>/data.ts); the component never hard-codes copy.

export interface CampaignUseCase {
  /** One-tap task prompt, e.g. "Research my top 5 competitors and ...". */
  prompt: string;
}

export interface CampaignConnector {
  name: string;
  icon: string;
  /** Dark-on-light glyph that needs inverting in dark mode. */
  dark?: boolean;
  /** Optional separate dark-mode icon. */
  darkIcon?: string;
}

export interface CampaignLandingConfig {
  /** LP slug, also reported as lp_slug. */
  slug: string;
  /** utm_campaign value baked into tracking (campaign-agnostic event names). */
  utm_campaign: string;
  /** Audience segment, reported alongside campaign. */
  segment: string;
  /** Above-the-fold H1. */
  h1: string;
  /** One-sentence value prop under the H1. */
  subhead: string;
  /** 3-4 one-tap task cards. */
  useCases: CampaignUseCase[];
  /** Connectors to lead the proof row with (rendered first, then the rest). */
  featuredConnectors: CampaignConnector[];
  /** Primary CTA label. */
  ctaText: string;
}

// The homepage's full connector set, used to fill out the proof row behind the
// campaign's featured connectors so the marquee stays as rich as the homepage.
const HOMEPAGE_CONNECTORS: CampaignConnector[] = [
  { name: "Notion", icon: "/assets/connectors/notion.svg", dark: true },
  { name: "Google Sheets", icon: "/assets/connectors/google-sheet.svg" },
  { name: "HubSpot", icon: "/assets/connectors/hubspot.svg" },
  { name: "Figma", icon: "/assets/connectors/figma.svg" },
  { name: "Vercel", icon: "/assets/connectors/vercel.svg", dark: true },
  { name: "Sentry", icon: "/assets/connectors/sentry.svg", dark: true },
  { name: "Airtable", icon: "/assets/connectors/airtable.svg" },
  { name: "Intercom", icon: "/assets/connectors/intercom.svg", dark: true },
  { name: "Dropbox", icon: "/assets/connectors/dropbox.svg" },
  { name: "Google Calendar", icon: "/assets/connectors/google-calendar.svg" },
  { name: "Ahrefs", icon: "/assets/connectors/ahref.svg" },
  { name: "DocuSign", icon: "/assets/connectors/docusign.svg" },
];

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

function ConnectorCard({ connector, i }: { connector: CampaignConnector; i: number }) {
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
}

export function CampaignLanding({ config }: { config: CampaignLandingConfig }) {
  const { isSignedIn: clerkIsSignedIn, isLoaded } = useUser();
  const isSignedIn = isLoaded ? (clerkIsSignedIn ?? false) : false;
  const revealRef = useScrollReveal();

  const appUrl = getAppUrl();
  const [landingSearch, setLandingSearch] = useState("");
  useEffect(() => {
    setLandingSearch(window.location.search);
  }, []);

  // Campaign-agnostic tracking taxonomy. Register the campaign dimensions on
  // load and fire a viewed event; event NAMES never get namespaced per
  // campaign so every paid page rolls up the same way.
  useEffect(() => {
    const props = {
      campaign: config.utm_campaign,
      segment: config.segment,
      lp_slug: config.slug,
    };
    try {
      posthog.register(props);
      posthog.capture("LP Viewed", props);
    } catch {
      // posthog may be uninitialized (no key); tracking is best-effort.
    }
    if (typeof window !== "undefined" && typeof window.plausible === "function") {
      window.plausible("LP Viewed", { props });
    }
  }, [config.utm_campaign, config.segment, config.slug]);

  const ctaText = isSignedIn ? "Open the app" : config.ctaText;
  const ctaHref = isSignedIn ? appUrl : buildSignupHref(landingSearch);

  function trackCtaClick(cta: string) {
    const props = {
      campaign: config.utm_campaign,
      segment: config.segment,
      lp_slug: config.slug,
      cta,
    };
    try {
      posthog.capture("LP CTA Clicked", props);
    } catch {
      // best-effort
    }
    if (typeof window !== "undefined" && typeof window.plausible === "function") {
      window.plausible("LP CTA Clicked", { props });
    }
  }

  const connectors = [...config.featuredConnectors, ...HOMEPAGE_CONNECTORS];

  function PrimaryCta({ cta, className }: { cta: string; className?: string }) {
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
          onClick={() => {
            return trackCtaClick(cta);
          }}
          className={baseClassName}
          style={style}
        >
          {ctaText}
        </a>
      );
    }
    return (
      <NextLink
        href={ctaHref}
        onClick={() => {
          return trackCtaClick(cta);
        }}
        className={baseClassName}
        style={style}
      >
        {ctaText}
      </NextLink>
    );
  }

  return (
    <div
      ref={revealRef}
      className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]"
    >
      {/* Noise grain overlay — full page (matches homepage) */}
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

      {/* Corner grid overlay (matches homepage) */}
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
        {/* ===== HERO ===== */}
        <section className="relative flex flex-col items-center overflow-hidden px-5 pt-[var(--total-header-height,80px)] sm:px-6">
          <div
            className="pointer-events-none absolute inset-x-0 z-[1] sm:left-[12.31%] sm:right-[12.82%]"
            style={{ top: "50%", transform: "translateY(-50%)", height: "80%" }}
          >
            <Image
              src="/assets/hero/decorative-shapes.svg"
              alt=""
              className="deco-shapes"
              fill
              priority
            />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-[1060px] flex-col items-center gap-10 pb-10 pt-[96px] sm:gap-[50px] sm:pt-[120px]">
            <div className="flex w-full flex-col items-center gap-6 text-center">
              <h1 className="w-full text-[32px] font-medium leading-[1.3] tracking-[-1.12px] text-[hsl(var(--foreground))] sm:text-[42px] sm:leading-[1.4] md:text-[51px]">
                {config.h1}
              </h1>
              <p className="max-w-2xl text-[16px] leading-7 text-[hsl(var(--muted-foreground))] sm:text-[18px]">
                {config.subhead}
              </p>
            </div>

            {/* Single primary CTA above the fold */}
            <div className="relative flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center sm:gap-4">
              <PrimaryCta cta="hero" />
            </div>
          </div>
        </section>

        {/* ===== CONNECTOR PROOF ROW ===== */}
        <section className="px-5 py-10 sm:px-6 sm:py-12 md:py-16">
          <div className="mx-auto flex max-w-[1060px] flex-col items-center gap-10">
            <div className="reveal flex flex-col items-center gap-4 rounded-[32px] px-2 pb-2 pt-6">
              <h2 className="landing-heading text-center text-[28px] font-medium leading-[1.2] tracking-[-0.88px] text-[hsl(var(--foreground))] sm:text-[34px] md:text-[40px]">
                Connects to the tools you already run on.
              </h2>
              <p className="max-w-[856px] text-center text-base leading-6 text-[hsl(var(--muted-foreground))]">
                Zero works across your stack so the work happens where it
                already lives.
              </p>
            </div>

            <div className="reveal w-full overflow-hidden">
              <div className="marquee-container flex flex-col gap-4">
                <div className="marquee-track">
                  <div className="marquee-scroll flex gap-3.5">
                    {[...connectors, ...connectors].map((connector, i) => {
                      return (
                        <ConnectorCard
                          key={`${connector.name}-${i}`}
                          connector={connector}
                          i={i}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===== SEGMENT USE-CASE CARDS ===== */}
        <section className="px-5 py-10 sm:px-6 sm:py-12 md:py-16">
          <div className="mx-auto max-w-[1152px]">
            <div className="reveal">
              <h2 className="landing-heading text-center text-[28px] font-medium leading-[1.2] tracking-[-0.88px] text-[hsl(var(--foreground))] sm:text-[34px] md:text-[40px]">
                Hand off the work you can&apos;t get to.
              </h2>
            </div>

            <div className="mt-12 grid gap-6 sm:mt-16 sm:grid-cols-2">
              {config.useCases.map((useCase, idx) => {
                return (
                  <div
                    key={useCase.prompt}
                    className="reveal flex flex-col gap-4 rounded-[20px] bg-white p-7 sm:p-8"
                  >
                    <span className="text-[11px] font-semibold uppercase tracking-[1.5px] text-[#ed4e01]">
                      {`One-tap task ${idx + 1}`}
                    </span>
                    <p className="text-[19px] font-medium leading-7 text-[hsl(var(--foreground))] sm:text-[21px] sm:leading-8">
                      {`“${useCase.prompt}”`}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ===== HOW IT WORKS ===== */}
        <section className="px-5 py-10 sm:px-6 sm:py-12 md:py-16">
          <div className="mx-auto flex max-w-[1152px] flex-col items-center gap-14">
            <div className="reveal">
              <h2 className="landing-heading max-w-[740px] text-center text-[28px] font-medium leading-[1.2] tracking-[-0.88px] text-[hsl(var(--foreground))] sm:text-[34px] md:text-[40px]">
                Set it up once, then just ask.
              </h2>
            </div>

            <div className="reveal grid w-full gap-8 sm:grid-cols-3">
              {(
                [
                  {
                    title: "Connect your tools",
                    desc: "Link GitHub, Linear, Slack, Gmail and more in a couple of clicks. Zero only sees what you grant.",
                  },
                  {
                    title: "Ask in plain language",
                    desc: "Tell Zero what you need in Slack or on the web. It plans the work and pulls from the right tools.",
                  },
                  {
                    title: "Get the work back",
                    desc: "Zero does the work and reports back. Schedule it to run on its own so it keeps shipping while you build.",
                  },
                ] as const
              ).map((item) => {
                return (
                  <div key={item.title} className="flex flex-col gap-2">
                    <h3 className="text-base font-bold leading-6 text-[hsl(var(--foreground))]">
                      {item.title}
                    </h3>
                    <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
                      {item.desc}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ===== CLOSING CTA ===== */}
        <section className="px-5 pb-10 pt-2 sm:px-6 sm:pb-12 md:pb-16">
          <div className="mx-auto max-w-[1152px]">
            <div className="flex flex-col items-start gap-6 rounded-[20px] bg-white px-6 py-8 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:px-10">
              <div className="flex flex-col gap-2">
                <h3 className="landing-heading text-[22px] font-medium leading-[1.3] tracking-[-0.5px] text-[hsl(var(--foreground))] sm:text-[26px]">
                  Get your AI co-founder working today.
                </h3>
                <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
                  Connect your tools and hand off the first task in minutes.
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4">
                <PrimaryCta cta="footer" className="shrink-0" />
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
