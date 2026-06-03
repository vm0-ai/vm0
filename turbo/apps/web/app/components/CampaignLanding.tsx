"use client";

import { useEffect, useRef } from "react";
import NextLink from "next/link";
import { useUser } from "@clerk/nextjs";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { posthog } from "posthog-js";
import { getAppUrl } from "../../src/lib/zero/url";
import { AvatarCustomizer } from "./AvatarCustomizer";
import { Footer } from "./Footer";
import { ACQUISITION_ATTRIBUTION_COOKIE } from "@vm0/api-contracts/contracts/zero-attribution";

// Ad params that arrive on the landing URL. We strip these from the visible
// address bar after attribution is durably captured, so the URL stays clean
// (homepage-consistent) without losing per-campaign attribution.
const LANDING_AD_PARAMS = [
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
  "vm0_source",
] as const;

function hasAttributionCookie(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.cookie.split(";").some((part) => {
    return part.trim().startsWith(`${ACQUISITION_ATTRIBUTION_COOKIE}=`);
  });
}

function searchHasAdParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return LANDING_AD_PARAMS.some((param) => {
    return params.has(param);
  });
}

// Remove only the ad params from the address bar, preserving any other query
// params, the hash, and the path. Uses replaceState so it leaves no history
// entry and never reloads (so PostHog state and the React tree are untouched).
function stripAdParamsFromUrl(): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const param of LANDING_AD_PARAMS) {
    if (url.searchParams.has(param)) {
      url.searchParams.delete(param);
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  const cleaned = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, "", cleaned);
}

// Config-driven paid campaign landing page. Reuses the homepage's design
// tokens, connector marquee, reveal-on-scroll behavior, and the homepage's
// clean /sign-up CTA so the trial funnel + Stripe/Clerk attribution stay
// intact: attribution flows through the shared `.vm0.ai` vm0_attribution
// cookie, not the CTA query string. Each paid segment is a pure config object
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

function ConnectorCard({
  connector,
  i,
}: {
  connector: CampaignConnector;
  i: number;
}) {
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

// Competitor comparison, lifted verbatim from the homepage (LandingPage.tsx)
// so every campaign page inherits the same "Why Zero" differentiation. The
// items, icons, markup, and copy (t("comparison.*") in messages/*.json) are
// shared with the homepage, so this matches it by construction across locales.
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

export function CampaignLanding({ config }: { config: CampaignLandingConfig }) {
  const { isSignedIn: clerkIsSignedIn, isLoaded } = useUser();
  const t = useTranslations("landing");
  const isSignedIn = isLoaded ? (clerkIsSignedIn ?? false) : false;
  const revealRef = useScrollReveal();

  const appUrl = getAppUrl();

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
    if (
      typeof window !== "undefined" &&
      typeof window.plausible === "function"
    ) {
      window.plausible("LP Viewed", { props });
    }
  }, [config.utm_campaign, config.segment, config.slug]);

  // Clean the visible address bar after an ad click: turn
  // /en/ai-cofounder?gclid=...&utm_* into /en/ai-cofounder, without losing
  // attribution.
  //
  // Sequencing is load-bearing. AttributionCapture reads
  // window.location.search and is gated on Termly advertising consent; it may
  // poll up to ~5s for Termly to initialize before writing the vm0_attribution
  // cookie. Stripping the URL before that runs would drop attribution for
  // consenting users (incl. US default-granted). So we only strip once we have
  // observed the cookie. If it never appears within the window, consent was
  // declined (or there is nothing to capture), in which case there is nothing
  // to lose and cleaning is safe. The page's own campaign value comes from
  // config (data.ts), not the URL, so posthog.register / LP Viewed are
  // unaffected by stripping.
  useEffect(() => {
    if (!searchHasAdParams(window.location.search)) {
      return;
    }

    // If the cookie is already present (revisit / fast consent), strip now.
    if (hasAttributionCookie()) {
      stripAdParamsFromUrl();
      return;
    }

    // Poll for the cookie. AttributionCapture polls Termly for ~5s (20 * 250ms);
    // give it a little headroom, then clean regardless (consent declined =>
    // no cookie will ever be written => safe to clean).
    let elapsed = 0;
    const intervalMs = 200;
    const maxWaitMs = 6000;
    const interval = window.setInterval(() => {
      elapsed += intervalMs;
      if (hasAttributionCookie() || elapsed >= maxWaitMs) {
        window.clearInterval(interval);
        stripAdParamsFromUrl();
      }
    }, intervalMs);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const ctaText = isSignedIn ? "Open the app" : config.ctaText;
  // Clean CTA, exactly like the homepage: no query decoration. Attribution is
  // carried by the shared `.vm0.ai` vm0_attribution cookie (written by
  // AttributionCapture), which the app reads on signup -> onboarding ->
  // checkout, so Clerk/Stripe still get per-campaign attribution.
  const ctaHref = isSignedIn ? appUrl : "/sign-up";

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
    if (
      typeof window !== "undefined" &&
      typeof window.plausible === "function"
    ) {
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
            {/* Interactive avatar customizer — matches the homepage hero */}
            <AvatarCustomizer />

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

        {/* ===== COMPARISON SECTION ===== */}
        {/* Reused verbatim from the homepage (LandingPage.tsx): same items,
            icons, markup, tokens, and t("comparison.*") copy. Shared across all
            campaign segments (not per-segment config). */}
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
