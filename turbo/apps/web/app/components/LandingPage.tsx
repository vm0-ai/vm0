"use client";

import { useEffect, useRef, useState } from "react";
import NextLink from "next/link";
import { useUser } from "@clerk/nextjs";
import { getAppUrl } from "../../src/lib/zero/url";
import Navbar from "./Navbar";
import Footer from "./Footer";
import Image from "next/image";
import AvatarCustomizer from "./AvatarCustomizer";

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
  const baseClassName = `inline-flex items-center justify-center rounded-xl px-14 py-3.5 text-base font-medium transition-all hover:bg-[#ff6a1f] ${className ?? ""}`;
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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="landing-heading text-center text-[28px] font-medium leading-[1.2] tracking-[-0.88px] text-[hsl(var(--foreground))] sm:text-[34px] md:text-[40px]">
      {children}
    </h2>
  );
}

function SlackThreadMockup() {
  return (
    <div className="relative h-[400px] flex-1 overflow-hidden rounded-br-[10px] bg-[#9a948d]">
      {/* Thread window */}
      <div className="absolute left-[147px] top-[24px] w-[345px]">
        {/* Thread background */}
        <div className="h-[482px] w-[345px] rounded-[15px] bg-white" />
        {/* Thread header */}
        <div className="absolute left-0 top-0 h-[48px] w-[345px] rounded-t-[9px] bg-white">
          <p
            className="absolute left-[13px] top-[10px] text-[11px] font-black text-black"
            style={{ fontFamily: "Lato, sans-serif" }}
          >
            Thread
          </p>
          <p
            className="absolute left-[13px] top-[26px] text-[9.5px] text-black/60"
            style={{ fontFamily: "Lato, sans-serif" }}
          >
            #all-vm0
          </p>
          {/* Close icon */}
          <svg
            className="absolute right-[19px] top-[16px]"
            width="15"
            height="15"
            viewBox="0 0 15 15"
            fill="none"
          >
            <path
              d="M3.5 3.5l8 8M11.5 3.5l-8 8"
              stroke="rgba(0,0,0,0.6)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
        {/* Divider */}
        <div className="absolute left-0 top-[47px] h-px w-[343px] bg-black/10" />
      </div>

      {/* Messages panel — overlapping thread */}
      <div className="absolute left-[160px] top-[71px] w-[322px] overflow-hidden rounded-[15px] py-[10px]">
        {/* Message 1 — Lancy */}
        <div className="relative mb-4 pl-0">
          <div className="absolute left-0 top-[1.5px] h-[26.5px] w-[26.5px] overflow-hidden rounded-[3.3px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt=""
              src="/assets/hero/slack-avatar-lancy.png"
              className="h-full w-full object-cover"
            />
          </div>
          <div className="ml-[33px]">
            <div className="flex items-center gap-[1.6px]">
              <span
                className="text-[11px] font-black text-black"
                style={{ fontFamily: "Lato, sans-serif" }}
              >
                Lancy
              </span>
              <span
                className="text-[8.8px] text-black/60"
                style={{ fontFamily: "Lato, sans-serif" }}
              >
                10:37 AM
              </span>
            </div>
            <p
              className="mt-[3px] text-[11px] leading-[16px] text-black"
              style={{ fontFamily: "Lato, sans-serif", width: 277 }}
            >
              <span className="font-semibold text-[#1364a3]">@Zero</span>
              {
                " Check my calendar, emails, and Linear tasks since last week and write me a work summary I can share with my team"
              }
            </p>
          </div>
        </div>

        {/* Message 2 — Zero */}
        <div className="relative pl-0">
          {/* Zero avatar */}
          <div className="absolute left-0 top-0 h-[26.3px] w-[26.3px] shrink-0 overflow-hidden rounded-[7.5px] bg-[#da7840]">
            <div className="absolute -left-[5.3px] -top-[5.3px] h-[34.7px] w-[34.7px] overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt=""
                src="/assets/hero/head0.png"
                className="absolute left-[-12.08%] top-[-9.17%] h-[541.67%] w-[486.88%] max-w-none"
              />
            </div>
            <div className="absolute -left-[5.3px] -top-[5.3px] h-[34.7px] w-[34.7px] overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt=""
                src="/assets/hero/hair1.png"
                className="absolute left-[-12.08%] top-[-40%] h-[652.29%] w-[478.12%] max-w-none"
              />
            </div>
            <div className="absolute -left-[5.3px] -top-[5.3px] h-[34.7px] w-[34.7px] overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt=""
                src="/assets/hero/face3.png"
                className="absolute left-[-10.83%] top-[-40.62%] h-[408.33%] w-[486.87%] max-w-none"
              />
            </div>
          </div>
          <div
            className="ml-[33px] w-[277px] overflow-hidden text-[11px] leading-[16px] text-black"
            style={{ fontFamily: "Lato, sans-serif" }}
          >
            <div className="mb-[3px] flex items-center gap-[3.3px]">
              <span
                className="text-[11px] font-black text-black"
                style={{ fontFamily: "Lato, sans-serif" }}
              >
                Zero
              </span>
              <span
                className="text-[8.8px] text-black/60"
                style={{ fontFamily: "Lato, sans-serif" }}
              >
                10:42 AM
              </span>
            </div>
            <p className="mb-[3px]">
              Got all the data. Composing the summary now.
            </p>
            <p className="mb-[3px]">
              {"Here\u2019s your work summary for the week of Mar 16\u201324:"}
            </p>
            <p className="mb-[3px] font-bold">{"Meetings & Collaboration"}</p>
            <ul className="mb-[3px] list-disc pl-[17px]">
              <li>Daily stand-ups with the team (Mon–Fri)</li>
              <li>Weekly sync with Ethan (Apr 4)</li>
              <li>{"External partnership call: Jason <> VM0 (Apr 3)"}</li>
              <li>User interview: Sarah Kim (Apr 9)</li>
              <li>Design sync with external illustrator (Apr 5)</li>
            </ul>
            <p className="mb-[3px] font-bold">Hiring</p>
            <ul className="mb-[3px] list-disc pl-[17px]">
              <li>
                Conducted 2 operations intern interviews with a follow-up on Apr
                6
              </li>
              <li>Conducted 2 product designer interviews</li>
            </ul>
            <p className="mb-[3px] font-bold">Notable External Thread</p>
            <ul className="mb-[3px] list-disc pl-[17px]">
              <li>
                Ongoing discussion with Notion (Product Partnerships team) on
                potential VM0 integration
              </li>
            </ul>
            <p className="mb-[3px]">Linear — Completed (14 tasks)</p>
            <ul className="mb-[3px] list-disc pl-[17px]">
              <li>
                Product design: Iterated onboarding flow (team setup),
                redesigned agent detail page, improved run logs experience,
                updated connectors management UI, and refined empty states
                across core pages
              </li>
              <li>
                Branding: Explored new illustration direction, updated marketing
                visuals, refined Zero character usage
              </li>
              <li>
                Bug fixes: Fixed activity log filtering issues, improved search
                responsiveness, addressed UI inconsistencies in agent run view
              </li>
              <li>
                Design system: Updated spacing system and typography scale for
                better consistency
              </li>
            </ul>
            <p className="mb-[3px]">Canceled / Scoped Out</p>
            <ul className="list-disc pl-[17px]">
              <li>
                A batch of 8 design tasks was dropped on Apr 6 (advanced
                scheduling UI, Slack notification redesign, billing page
                iteration, etc.) — likely due to shifting priorities or tighter
                focus on core flows
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
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

function SlackMockup() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.classList.add("in-view");
        } else {
          el.classList.remove("in-view");
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => {
      return observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className="flex flex-1 items-center justify-center overflow-hidden bg-[#9a948d] md:h-[400px]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt="Slack thread showing Zero AI assistant"
        src="/assets/mockup/atslack.png"
        className="slack-thread-pop h-full w-full object-contain"
        draggable={false}
      />
    </div>
  );
}

function SlackCard() {
  return (
    <div className="overflow-hidden rounded-[20px] bg-white">
      <div className="flex flex-col md:flex-row">
        {/* Left text content */}
        <div className="flex w-full flex-col justify-between gap-4 p-10 md:w-[421px] md:shrink-0">
          <div className="flex flex-col gap-4">
            <h3 className="text-2xl font-medium leading-8 text-[hsl(var(--foreground))]">
              Natively integrated into Slack, just @
            </h3>
            <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
              One question. All your work, summarized. Keep your team in sync.
              No dashboards needed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-[hsl(var(--gray-100))] px-4 py-1.5 text-sm font-medium text-[hsl(var(--muted-foreground))]">
              Operations
            </span>
            <span className="rounded-lg bg-[hsl(var(--gray-100))] px-4 py-1.5 text-sm font-medium text-[hsl(var(--muted-foreground))]">
              Team Sync
            </span>
          </div>
        </div>
        {/* Right Slack mockup */}
        <SlackMockup />
      </div>
    </div>
  );
}

function SyncedToolsIllustration() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.classList.add("in-view");
        } else {
          el.classList.remove("in-view");
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => {
      return observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className="relative flex h-[400px] flex-1 items-center justify-center overflow-hidden rounded-bl-[10px] rounded-br-[10px] bg-[#39a2a3] py-3"
    >
      <div className="relative h-[355px] w-[500px]">
        {/* Slack icon — top-left */}
        <div className="absolute left-0 top-0 z-10 flex size-[26px] items-center justify-center rounded-[6px] border border-black/[0.08] bg-white p-1 shadow-[0px_7px_7px_0px_rgba(0,0,0,0.08)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt="Slack"
            src="/assets/tool-sync/slack-icon.png"
            className="size-[19px]"
          />
        </div>

        {/* Zero chat screenshot — left */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt="Zero chat creating a Notion database of KOLs"
          src="/assets/tool-sync/zero-chat.png"
          className="sync-chat absolute left-[8px] top-[9px] z-[1] w-[348px] rounded-[9px]"
          draggable={false}
        />

        {/* Notion/download icon — above Notion screenshot */}
        <div className="absolute left-[204px] top-[53px] z-10 flex size-[26px] items-center justify-center rounded-[6px] border border-black/[0.08] bg-white p-1 shadow-[0px_7px_7px_0px_rgba(0,0,0,0.08)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt="Notion"
            src="/assets/tool-sync/download-icon.png"
            className="size-[19px]"
          />
        </div>

        {/* Arrow connecting the two screenshots */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt=""
          src="/assets/tool-sync/arrow.png"
          className="sync-arrow absolute left-[155px] top-[147px] z-[5] w-[75px] -scale-y-100"
          draggable={false}
        />

        {/* Notion database screenshot — right, overlapping */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt="Notion database showing KOL Tracker for AI & Dev Tools"
          src="/assets/tool-sync/notion-db.png"
          className="sync-notion absolute left-[215px] top-[63px] z-[2] w-[385px] rounded-[7px] shadow-[0px_0px_7px_7px_rgba(0,0,0,0.08)]"
          draggable={false}
        />
      </div>
    </div>
  );
}

function SyncedToolsMockup() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.classList.add("in-view");
        } else {
          el.classList.remove("in-view");
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => {
      return observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className="flex flex-1 items-center justify-center overflow-hidden bg-[#39A2A3] p-2 sm:p-8"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt="Synced across tools"
        src="/assets/mockup/across-tools.png"
        className="synced-tools-pop h-full w-full object-cover"
        draggable={false}
      />
    </div>
  );
}

function SyncedToolsCard() {
  return (
    <div className="overflow-hidden rounded-[20px] bg-white">
      <div className="flex flex-col md:flex-row">
        {/* Left text content */}
        <div className="flex w-full flex-col justify-between gap-4 p-10 md:w-[421px] md:shrink-0">
          <div className="flex flex-col gap-4">
            <h3 className="text-2xl font-medium leading-8 text-[hsl(var(--foreground))]">
              From discovery to outreach, agents do the legwork.
            </h3>
            <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
              Tell Zero who you&apos;re looking for. Its agents crawl social
              platforms, build prospect lists, and draft personalized outreach
              so your team focuses on closing, not searching.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-[hsl(var(--gray-100))] px-4 py-1.5 text-sm font-medium text-[hsl(var(--muted-foreground))]">
              Marketing Outreach
            </span>
            <span className="rounded-lg bg-[hsl(var(--gray-100))] px-4 py-1.5 text-sm font-medium text-[hsl(var(--muted-foreground))]">
              Cross-platform
            </span>
          </div>
        </div>
        {/* Right illustration */}
        <SyncedToolsMockup />
      </div>
    </div>
  );
}

/* ── App UI carousel for "Teammate" card ── */

const WEB_UI_SLIDES = [
  "/assets/mockup/web-ui-1.png",
  "/assets/mockup/web-ui-2.png",
  "/assets/mockup/web-ui-3.png",
];

function AppMockupCarousel() {
  const [active, setActive] = useState(0);
  const ref = useInView();
  // Sidebar is ~26% of 855px width
  const sidebarPct = "26%";

  return (
    <div ref={ref} className="relative w-full overflow-hidden rounded-t-xl">
      {/* Full images — instant switch, no animation */}
      {WEB_UI_SLIDES.map((src, i) => {
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={src}
            alt=""
            src={src}
            className={`webui-pop w-full select-none ${i === active ? "relative" : "absolute inset-0 opacity-0"}`}
            draggable={false}
          />
        );
      })}
      {/* Clickable hotspots over sidebar chat items */}
      <div className="absolute inset-0 z-20">
        <button
          type="button"
          aria-label="Daily Report"
          onClick={() => {
            return setActive(0);
          }}
          className="absolute cursor-pointer"
          style={{ left: "1%", top: "49%", width: "19%", height: "5%" }}
        />
        <button
          type="button"
          aria-label="Email Leads"
          onClick={() => {
            return setActive(1);
          }}
          className="absolute cursor-pointer"
          style={{ left: "1%", top: "54%", width: "19%", height: "5%" }}
        />
        <button
          type="button"
          aria-label="Sentry Report"
          onClick={() => {
            return setActive(2);
          }}
          className="absolute cursor-pointer"
          style={{ left: "1%", top: "59%", width: "19%", height: "5%" }}
        />
      </div>
      {/* Hand-drawn arrow pointer */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/assets/mockup/arrow-pointer.svg"
        alt=""
        className="pointer-events-none absolute z-20 w-[10%]"
        style={{ left: "18%", top: "40%", transform: "none" }}
        draggable={false}
      />
    </div>
  );
}

function TeammateCard() {
  return (
    <div className="overflow-hidden rounded-[20px] bg-white">
      <div className="flex flex-col gap-4 p-8 sm:p-10">
        <h3 className="text-2xl font-medium leading-8 text-[hsl(var(--foreground))]">
          Your team, extended.
        </h3>
        <p className="text-sm leading-6 text-[hsl(var(--muted-foreground))] sm:text-base">
          Zero is not a tool. It&apos;s the one using them. Zero comes with a
          team of specialized sub-agents you configure yourself. They work
          inside your existing tools, understand your context, and ship real
          output.
        </p>
      </div>
      <div className="bg-[#d58341] px-2 pb-0 pt-3 sm:px-6 sm:pt-6">
        <AppMockupCarousel />
      </div>
    </div>
  );
}

/* ── Security section illustration ── */

function SecureByDesignIllustration() {
  return (
    <div className="relative h-[320px] w-full overflow-hidden rounded-b-[10px] bg-[#e7ebf0]">
      {/* Horizontal lines with dotted overlays */}
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 500 320"
        fill="none"
        preserveAspectRatio="xMidYMid slice"
      >
        {/* Solid gray lines */}
        <line
          x1="0"
          y1="119"
          x2="500"
          y2="119"
          stroke="#c5ccd7"
          strokeWidth="0.7"
        />
        <line
          x1="0"
          y1="155"
          x2="500"
          y2="155"
          stroke="#c5ccd7"
          strokeWidth="0.7"
        />
        <line
          x1="0"
          y1="190"
          x2="500"
          y2="190"
          stroke="#c5ccd7"
          strokeWidth="0.7"
        />
        {/* Colored dotted lines */}
        <line
          x1="0"
          y1="131"
          x2="500"
          y2="131"
          stroke="#9ba3b3"
          strokeWidth="1"
          strokeDasharray="3 5"
        />
        <line
          x1="0"
          y1="167"
          x2="500"
          y2="167"
          stroke="#d96b6b"
          strokeWidth="1"
          strokeDasharray="3 5"
        />
        <line
          x1="0"
          y1="203"
          x2="500"
          y2="203"
          stroke="#9ba3b3"
          strokeWidth="1"
          strokeDasharray="3 5"
          opacity="0.5"
        />
      </svg>

      {/* 3D Cube */}
      <div className="absolute left-1/2 top-[85px] -translate-x-1/2">
        <svg width="166" height="166" viewBox="0 0 166 166" fill="none">
          {/* Outer hexagon */}
          <path
            d="M83 5L155 46.5V129.5L83 171L11 129.5V46.5L83 5Z"
            fill="#C4B544"
          />
          {/* Top face */}
          <path d="M83 5L155 46.5L83 88L11 46.5L83 5Z" fill="#D4C44E" />
          {/* Right face */}
          <path d="M155 46.5L83 88V171L155 129.5V46.5Z" fill="#B8A83E" />
          {/* Left face */}
          <path d="M11 46.5L83 88V171L11 129.5V46.5Z" fill="#C4B544" />
          {/* Inner cube - darker */}
          <path
            d="M83 55L120 76.5V119.5L83 141L46 119.5V76.5L83 55Z"
            fill="#8B7D2E"
            opacity="0.6"
          />
          <path
            d="M83 55L120 76.5L83 98L46 76.5L83 55Z"
            fill="#9B8C33"
            opacity="0.6"
          />
          <path
            d="M120 76.5L83 98V141L120 119.5V76.5Z"
            fill="#7A6E28"
            opacity="0.6"
          />
          <path
            d="M46 76.5L83 98V141L46 119.5V76.5Z"
            fill="#8B7D2E"
            opacity="0.6"
          />
        </svg>
      </div>

      {/* GitHub icon */}
      <div className="absolute bottom-[22px] right-[22px]">
        <svg width="39" height="39" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"
            fill="#c5ccd7"
          />
        </svg>
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

export default function LandingPage() {
  const { isSignedIn } = useUser();
  const revealRef = useScrollReveal();

  const ctaText = isSignedIn ? "Open app" : "Get started";
  const ctaHref = isSignedIn ? getAppUrl() : "/sign-up";

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

      <div className="header-container">
        <Navbar />
      </div>

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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/assets/hero/decorative-shapes.svg"
              alt=""
              className="h-full w-full deco-shapes"
            />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-[1060px] flex-col items-center gap-[50px] pb-10 pt-[140px]">
            <div className="flex w-full flex-col items-center gap-8">
              {/* Banner pill — hidden for now */}
              <NextLink
                href="/blog"
                className="hidden items-center gap-2 rounded-lg border border-[hsl(var(--gray-200))] bg-white px-3 py-1.5 text-sm text-[hsl(var(--foreground))] transition-colors hover:border-[hsl(var(--gray-400))] hover:bg-white"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/assets/hero/announcement-icon.svg"
                  alt=""
                  className="h-4 w-[22px]"
                />
                <span>Check out our $14M seed round fundraising blog.</span>
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
                  Zero, your trustworthy AI teammate{" "}
                  <br className="hidden sm:inline" />
                  for real work.
                </h1>
                <p className="max-w-2xl text-[16px] leading-7 text-[hsl(var(--muted-foreground))] sm:text-[18px]">
                  For individuals and teams. AI handles the busywork, context,
                  and noise. <span className="font-bold">Securely</span>. You
                  focus on creating.
                </p>
              </div>
            </div>

            {/* CTA Button — hero large */}
            <div className="relative">
              <CtaButton
                isSignedIn={isSignedIn ?? false}
                ctaText={ctaText}
                ctaHref={ctaHref}
              />
            </div>
          </div>
        </section>

        {/* ===== WORKS FOR YOU SECTION ===== */}
        <section className="px-5 py-10 sm:px-6 sm:py-12 md:py-16">
          <div className="mx-auto max-w-[1152px]">
            <div className="reveal">
              <SectionHeading>Zero works for you and your team</SectionHeading>
            </div>

            <div className="mt-12 space-y-8 sm:mt-16">
              <div className="reveal">
                <TeammateCard />
              </div>
              <div className="reveal">
                <SlackCard />
              </div>
              <div className="reveal">
                <SyncedToolsCard />
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
                100+ prebuilt connectors
              </h2>
              <p className="max-w-[856px] text-center text-base leading-6 text-[hsl(var(--muted-foreground))]">
                100+ prebuilt connectors, making it easier for AI to help you
                securely manage tasks across platforms and services.
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
                Zero is built with carefully designed security features
              </h2>
            </div>

            <div className="reveal mt-14 flex flex-col gap-6 md:flex-row">
              {/* Permission management card */}
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-white">
                <div className="flex flex-col gap-4 p-10">
                  <h3 className="text-2xl font-medium leading-8 text-[hsl(var(--foreground))]">
                    Permission management
                  </h3>
                  <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
                    You decide what Zero can see and do. Set granular read and
                    write permissions for each connected tool, so your agents
                    only access what they need.
                  </p>
                </div>
                <div className="flex h-[300px] items-center justify-center rounded-b-[20px] bg-[hsl(var(--gray-100))] px-10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt="Permission management interface"
                    src="/assets/mockup/permission-management.svg"
                    className="w-full max-w-[448px]"
                    draggable={false}
                  />
                </div>
              </div>

              {/* Secure by design card */}
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-white">
                <div className="flex flex-col gap-4 p-10">
                  <h3 className="text-2xl font-medium leading-8 text-[hsl(var(--foreground))]">
                    Secure by design
                  </h3>
                  <p className="min-h-[72px] text-base leading-6 text-[hsl(var(--muted-foreground))]">
                    Every action runs in an isolated microVM. Your credentials
                    are never exposed. Millisecond execution. And yes, it{"'"}s{" "}
                    <a
                      href="https://github.com/vm0-ai/vm0"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-[#45A7A8] underline underline-offset-2 hover:text-[#3a8e8f]"
                    >
                      open source
                    </a>
                    .
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
                Agent intelligence is what makes Zero feel human-like
              </h2>
            </div>

            {/* Two large cards */}
            <div className="reveal grid w-full gap-6 md:grid-cols-2">
              {/* Persistent memory card */}
              <div className="flex flex-col overflow-hidden rounded-[20px] bg-white">
                <div className="flex flex-1 flex-col gap-4 px-8 pb-4 pt-8 sm:px-10 sm:pt-10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt=""
                    src="/assets/agent-intelligence/memory-icon.svg"
                    className="h-[22px] w-[24px] landing-icon-invert"
                  />
                  <h3 className="text-2xl font-medium leading-8 text-[hsl(var(--foreground))]">
                    Persistent memory
                  </h3>
                  <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
                    {`Zero remembers context across conversations, past decisions, user preferences, project context, and behavioral corrections. You don't need to re-explain things every session.`}
                  </p>
                </div>
                <MemoryMockupArea />
              </div>

              {/* Scheduled intelligence card */}
              <div className="flex flex-col overflow-hidden rounded-[20px] bg-white">
                <div className="flex flex-1 flex-col gap-4 px-8 pb-4 pt-8 sm:px-10 sm:pt-10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt=""
                    src="/assets/agent-intelligence/schedule-icon.svg"
                    className="size-[24px] landing-icon-invert"
                  />
                  <h3 className="text-2xl font-medium leading-8 text-[hsl(var(--foreground))]">
                    Scheduled intelligence
                  </h3>
                  <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
                    Zero runs autonomous recurring tasks, daily error scans,
                    tech debt reports, morning briefs, without being prompted.
                  </p>
                </div>
                <ScheduleMockupArea />
              </div>
            </div>

            {/* Three bottom benefit items */}
            <div className="reveal grid w-full gap-8 sm:grid-cols-3">
              {[
                {
                  icon: "/assets/agent-intelligence/delegation-icon.svg",
                  title: "Delegation to specialized agents",
                  description:
                    "Zero spins up sub-agents that act like dedicated teammates, a researcher Lisa, a designer Lucy, each with their own expertise, working in parallel on your behalf.",
                },
                {
                  icon: "/assets/agent-intelligence/tool-orchestration-icon.svg",
                  title: "Tool orchestration",
                  description:
                    "Zero selects and chains the right tools from 100+ available integrations. You describe the goal; Zero figures out the steps.",
                },
                {
                  icon: "/assets/agent-intelligence/identity-resolution-icon.svg",
                  title: "Identity resolution",
                  description:
                    'When you say "my PRs" or "assign to me," Zero queries GitHub/Slack/Linear to figure out who you are, no assumptions, no hardcoded names.',
                },
              ].map((item) => {
                return (
                  <div key={item.title} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <div className="flex size-[30px] items-center justify-center overflow-hidden rounded-full">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img alt="" src={item.icon} className="size-[22px]" />
                      </div>
                      <h3 className="text-base font-bold leading-6 text-[hsl(var(--foreground))]">
                        {item.title}
                      </h3>
                    </div>
                    <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
                      {item.description}
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
                  People lead. Agents deliver. Together, they ship.
                </h3>
                <p className="text-base leading-6 text-[hsl(var(--muted-foreground))]">
                  When humans and AI agents work as one team, your output
                  multiplies.
                </p>
              </div>
              <CtaButton
                isSignedIn={isSignedIn ?? false}
                ctaText={ctaText}
                ctaHref={ctaHref}
                className="shrink-0"
              />
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
