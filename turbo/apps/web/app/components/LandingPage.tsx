"use client";

import NextLink from "next/link";
import { useUser } from "@clerk/nextjs";
import { getAppUrl } from "../../src/lib/zero/url";
import Navbar from "./Navbar";
import Footer from "./Footer";
import Image from "next/image";
import AvatarCustomizer from "./AvatarCustomizer";

const CONNECTORS = [
  [
    { name: "Axiom", icon: "/assets/connectors/axiom.svg" },
    { name: "Ahref", icon: "/assets/connectors/ahref.svg" },
    { name: "Airtable", icon: "/assets/connectors/airtable.svg" },
    { name: "Gmail", icon: "/assets/connectors/gmail.svg" },
    { name: "Google sheet", icon: "/assets/connectors/google-sheet.svg" },
    { name: "Notion", icon: "/assets/connectors/notion.svg" },
  ],
  [
    { name: "DocuSign", icon: "/assets/connectors/docusign.svg" },
    { name: "Linear", icon: "/assets/connectors/linear.svg" },
    { name: "Google Calendar", icon: "/assets/connectors/google-calendar.svg" },
    { name: "Intercom", icon: "/assets/connectors/intercom.svg" },
    { name: "Deel", icon: "/assets/connectors/deel.svg" },
  ],
  [
    { name: "HubSpot", icon: "/assets/connectors/hubspot.svg" },
    { name: "Dropbox", icon: "/assets/connectors/dropbox.svg" },
    { name: "Sentry", icon: "/assets/connectors/sentry.svg" },
    { name: "Figma", icon: "/assets/connectors/figma.svg" },
    { name: "Vercel", icon: "/assets/connectors/vercel.svg" },
  ],
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
  const baseClassName = `inline-flex items-center justify-center rounded-xl px-14 py-3.5 text-base font-medium text-white transition-all hover:bg-[#ff6a1f] ${className ?? ""}`;
  const style = {
    background: "#ed4e01",
    boxShadow: "inset 0 -2px 0 #a33703",
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
    <h2 className="landing-heading text-center text-[28px] font-semibold leading-[1.2] tracking-[-0.88px] text-[#14171d] sm:text-[34px] md:text-[40px]">
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

function SlackCard() {
  return (
    <div className="overflow-hidden rounded-[20px] bg-white">
      <div className="flex flex-col md:flex-row">
        {/* Left text content */}
        <div className="flex w-full flex-col gap-4 p-10 md:w-[421px] md:shrink-0">
          <h3 className="text-2xl font-bold leading-8 text-[#14171d]">
            Natively integrated into Slack, just @
          </h3>
          <p className="text-base leading-6 text-[#525b68]">
            One question. All your work, summarized. Keep your team in sync. No
            dashboards needed.
          </p>
        </div>
        {/* Right Slack mockup */}
        <SlackThreadMockup />
      </div>
    </div>
  );
}

function SyncedToolsIllustration() {
  return (
    <div className="relative flex h-[400px] flex-1 items-center justify-center overflow-hidden rounded-bl-[10px] rounded-br-[10px] bg-[#39a2a3] py-3">
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
          className="absolute left-[8px] top-[9px] z-[1] w-[348px] rounded-[9px]"
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
          className="absolute left-[155px] top-[147px] z-[5] w-[75px] -scale-y-100 rotate-[148deg]"
          draggable={false}
        />

        {/* Notion database screenshot — right, overlapping */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt="Notion database showing KOL Tracker for AI & Dev Tools"
          src="/assets/tool-sync/notion-db.png"
          className="absolute left-[215px] top-[63px] z-[2] w-[385px] rounded-[7px] shadow-[0px_0px_7px_7px_rgba(0,0,0,0.08)]"
          draggable={false}
        />
      </div>
    </div>
  );
}

function SyncedToolsCard() {
  return (
    <div className="overflow-hidden rounded-[20px] bg-white">
      <div className="flex flex-col md:flex-row-reverse">
        {/* Right illustration */}
        <div className="flex flex-1 items-center justify-center bg-[#39A2A3] p-8">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt="Synced across tools"
            src="/assets/mockup/across-tools.png"
            className="h-full w-full object-cover"
            draggable={false}
          />
        </div>
        {/* Left text content */}
        <div className="flex w-full flex-col gap-4 p-10 md:w-[421px] md:shrink-0">
          <h3 className="text-2xl font-bold leading-8 text-[#14171d]">
            Manage synced across tools with your intent
          </h3>
          <p className="text-base leading-6 text-[#525b68]">
            Already at Work, Zero connects to your tools, understands your team,
            and gets things done.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── App UI mockup for "Teammate, not tool" card — exported SVG from Figma ── */

function AppMockup() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt="VM0 app interface showing a chat conversation about migrating Zapier workflows"
      src="/assets/mockup/details-page.svg"
      className="mx-auto w-full max-w-[831px] select-none"
      aria-hidden="true"
      draggable={false}
    />
  );
}

function TeammateCard() {
  return (
    <div className="overflow-hidden rounded-[20px] bg-white">
      <div className="flex flex-col gap-4 p-8 sm:p-10">
        <h3 className="text-2xl font-bold leading-8 text-[#14171d]">
          Teammate, not tool
        </h3>
        <p className="text-sm leading-6 text-[hsl(var(--muted-foreground))] sm:text-base">
          No new app or tab switching, an intelligent co-worker that operates
          all your tools and actually gets the work done, not just chats.
        </p>
      </div>
      <div className="flex items-center justify-center bg-[#d58341] py-[40px]">
        <AppMockup />
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

export default function LandingPage() {
  const { isSignedIn } = useUser();

  const ctaText = isSignedIn ? "Open app" : "Get started";
  const ctaHref = isSignedIn ? getAppUrl() : "/sign-up";

  return (
    <div
      className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]"
      style={{
        backgroundImage: 'url("/images/paper-bg.png")',
        backgroundSize: "300px",
        backgroundRepeat: "repeat",
      }}
    >
      <div className="header-container">
        <Navbar />
      </div>

      <main>
        {/* ===== HERO SECTION ===== */}
        <section className="relative flex flex-col items-center overflow-hidden px-5 pt-[var(--total-header-height,80px)] sm:px-6">
          {/* Decorative background shapes */}
          <div
            className="pointer-events-none absolute z-[1]"
            style={{
              left: "12.31%",
              right: "12.82%",
              top: "50%",
              transform: "translateY(-50%)",
              height: "62.83%",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/assets/hero/decorative-shapes.svg"
              alt=""
              className="h-full w-full"
            />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-[1060px] flex-col items-center gap-[50px] pb-5 pt-[60px]">
            <div className="flex w-full flex-col items-center gap-8">
              {/* Banner pill */}
              <a
                href="/blog"
                className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-sm text-[#14171d] transition-colors hover:border-[hsl(var(--gray-400))] hover:bg-[hsl(var(--gray-50))]"
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
              </a>

              {/* Interactive avatar customizer */}
              <AvatarCustomizer />

              {/* Heading + Subtitle */}
              <div className="flex w-full flex-col items-center gap-[15px] text-center">
                <h1 className="w-full text-[32px] font-medium leading-[1.4] tracking-[-1.12px] text-[#14171d] sm:text-[42px] md:text-[51px]">
                  Zero, your trustworthy AI teammate{" "}
                  <br className="hidden sm:inline" />
                  for real work.
                </h1>
                <p className="max-w-2xl text-[16px] leading-7 text-[#525b68] sm:text-[18px]">
                  Do everything in Slack and on the web, for individuals and
                  team collaboration. <br className="hidden sm:inline" />
                  AI handles the managing the paperwork, the context, the noise,{" "}
                  <span className="font-bold">safely</span>. You do the
                  creating.
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
        <section className="px-5 py-20 sm:px-6 sm:py-24 md:py-28">
          <div className="mx-auto max-w-[1152px]">
            <SectionHeading>Zero works for you and your team</SectionHeading>

            <div className="mt-12 space-y-8 sm:mt-16">
              <TeammateCard />

              <SlackCard />

              <SyncedToolsCard />
            </div>
          </div>
        </section>

        {/* ===== CONNECTORS SECTION ===== */}
        <section className="px-5 py-20 sm:px-6 sm:py-24 md:py-28">
          <div className="mx-auto flex max-w-[1060px] flex-col items-center gap-10">
            {/* Title block */}
            <div className="flex flex-col items-center gap-4 rounded-[32px] px-2 pb-2 pt-6">
              <h2 className="landing-heading text-center text-[28px] font-semibold leading-[1.2] tracking-[-0.88px] text-[#14171d] sm:text-[34px] md:text-[40px]">
                100+ prebuilt connectors
              </h2>
              <p className="max-w-[856px] text-center text-sm leading-6 text-[hsl(var(--muted-foreground))] sm:text-base">
                100+ prebuilt connectors, making it easier for AI to help you
                securely manage tasks across platforms and services.
              </p>
            </div>

            {/* Connector pills */}
            <div className="flex w-full max-w-[1060px] flex-col items-center gap-6">
              {CONNECTORS.map((row, rowIndex) => (
                <div
                  key={rowIndex}
                  className="flex flex-wrap items-center justify-center gap-3.5"
                >
                  {row.map((connector) => (
                    <div
                      key={connector.name}
                      className="flex items-center gap-3.5 rounded-[22.4px] border border-[hsl(var(--gray-200))] bg-[#fcfdfd] p-3.5"
                    >
                      <Image
                        src={connector.icon}
                        alt={connector.name}
                        width={34}
                        height={34}
                        className="h-[34px] w-[34px] shrink-0"
                      />
                      <span className="whitespace-nowrap text-[19.6px] font-medium leading-7 text-black">
                        {connector.name}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ===== SECURITY SECTION ===== */}
        <section className="px-5 py-20 sm:px-6 sm:py-24 md:py-28">
          <div className="mx-auto max-w-[1152px]">
            <h2 className="landing-heading text-center text-[28px] font-semibold leading-[1.2] tracking-[-0.88px] text-[#14171d] sm:text-[34px] md:text-[40px]">
              Zero is built with carefully designed security features
            </h2>

            <div className="mt-14 flex flex-col gap-6 md:flex-row">
              {/* Permission management card */}
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-white">
                <div className="flex flex-col gap-4 p-10">
                  <h3 className="text-2xl font-bold leading-8 text-[#14171d]">
                    Permission management
                  </h3>
                  <p className="text-base leading-6 text-[#525b68]">
                    Stay in control. Grant agents exactly the right access, no
                    more, no less.
                  </p>
                </div>
                <div className="flex flex-1 items-center justify-center rounded-b-[20px] bg-[#e7ebf0] p-10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt="Permission management interface"
                    src="/assets/mockup/permission-managment.svg"
                    className="w-full max-w-[448px]"
                    draggable={false}
                  />
                </div>
              </div>

              {/* Secure by design card */}
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-white">
                <div className="flex flex-col gap-4 p-10">
                  <h3 className="text-2xl font-bold leading-8 text-[#14171d]">
                    Secure by design
                  </h3>
                  <p className="text-base leading-6 text-[#525b68]">
                    Isolated microVMs, no credential exposure, verifiable audit
                    logs, millisecond execution, open source.
                  </p>
                </div>
                <div className="flex flex-1 items-center justify-center rounded-b-[20px] bg-[#e7ebf0] p-10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt="Secure by design"
                    src="/assets/mockup/cube-zero.svg"
                    className="w-full max-w-[448px]"
                    draggable={false}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===== AGENT INTELLIGENCE SECTION ===== */}
        <section className="px-5 py-20 sm:px-6 sm:py-24 md:py-28">
          <div className="mx-auto flex max-w-[1152px] flex-col items-center gap-14">
            {/* Section title */}
            <h2 className="landing-heading max-w-[740px] text-center text-[28px] font-semibold leading-[1.2] tracking-[-0.88px] text-[#14171d] sm:text-[34px] md:text-[40px]">
              Agent intelligence is what makes Zero feel human-like
            </h2>

            {/* Two large cards */}
            <div className="grid w-full gap-6 md:grid-cols-2">
              {/* Persistent memory card */}
              <div className="flex flex-col overflow-hidden rounded-[20px] bg-white">
                <div className="flex flex-col gap-4 p-8 sm:p-10">
                  <h3 className="text-2xl font-bold leading-8 text-[#14171d]">
                    Persistent memory
                  </h3>
                  <p className="text-base leading-6 text-[#525b68]">
                    {`Zero remembers context across conversations, past decisions, user preferences, project context, and behavioral corrections. You don't need to re-explain things every session.`}
                  </p>
                </div>
                <div className="relative min-h-[360px] flex-1 overflow-hidden rounded-b-[20px] bg-[#e0bb3c]">
                  {/* Memory badge */}
                  <div className="absolute left-[30px] top-[59px] z-10 flex items-center gap-[5px] rounded-[13px] border-[0.4px] border-white bg-[#fcfdfd] px-2 py-2 shadow-[0px_8px_8px_0px_rgba(0,0,0,0.08)]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      alt=""
                      src="/assets/agent-intelligence/memory-icon.svg"
                      className="h-[13px] w-[14.5px]"
                    />
                    <span className="text-[11.3px] font-semibold text-black">
                      Memory
                    </span>
                  </div>
                  {/* Chat mockup card */}
                  <div className="absolute left-1/2 top-[74px] flex w-[400px] -translate-x-1/2 flex-col rounded-[10px] bg-white p-4">
                    {/* User message bubble */}
                    <div className="flex justify-end">
                      <div className="max-w-[291px] rounded-[12px] bg-[rgba(230,234,239,0.95)] px-[10px] py-[7px]">
                        <p className="text-[11.6px] leading-[18.8px] text-[#15181e]">
                          Audit vm0.ai pages against{" "}
                          <strong>our product direction</strong> and{" "}
                          <strong>past decisions</strong>. Flag what to keep,
                          update, or remove, with SEO improvements and next
                          steps. Create a Linear project with structured issues
                          for the <strong>right owners</strong>.
                        </p>
                      </div>
                    </div>
                    {/* Response text */}
                    <div className="mt-[5px] pt-[7px]">
                      <p className="text-[11.6px] leading-[18.8px] text-[#15181e]">
                        Research complete. Full report ready. All vm0.ai pages
                        are mapped and synced to Notion{" "}
                        <span className="font-medium text-[#06679f]">here</span>
                        <span className="font-medium text-[#075786]">.</span>
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Scheduled intelligence card */}
              <div className="flex flex-col overflow-hidden rounded-[20px] bg-white">
                <div className="flex flex-col gap-4 p-8 sm:p-10">
                  <h3 className="text-2xl font-bold leading-8 text-[#14171d]">
                    Scheduled intelligence
                  </h3>
                  <p className="min-h-[72px] text-base leading-6 text-[#525b68]">
                    Zero runs autonomous recurring tasks, daily error scans,
                    tech debt reports, morning briefs, without being prompted.
                  </p>
                </div>
                <div className="relative min-h-[360px] flex-1 overflow-hidden rounded-b-[20px] bg-[#ed71a5]">
                  {/* Schedule badge */}
                  <div className="absolute left-[30px] top-[59px] z-10 flex items-center gap-[5px] rounded-[13px] border-[0.4px] border-white bg-[#fcfdfd] px-2 py-2 shadow-[0px_8px_8px_0px_rgba(0,0,0,0.08)]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      alt=""
                      src="/assets/agent-intelligence/schedule-icon.svg"
                      className="size-4"
                    />
                    <span className="text-[11.3px] font-semibold text-black">
                      Schedule
                    </span>
                  </div>
                  {/* Schedule mockup card */}
                  <div className="absolute left-1/2 top-[80px] flex w-[400px] -translate-x-1/2 flex-col items-center justify-center overflow-hidden rounded-[10px] bg-white p-4 shadow-[0px_1.6px_101px_40px_rgba(0,0,0,0.08)]">
                    <div className="flex w-full flex-col gap-[13px]">
                      {/* Header */}
                      <div className="flex w-full flex-col gap-1">
                        <span className="text-[11.6px] font-semibold text-black">
                          {"Zero's schedule"}
                        </span>
                        <span className="overflow-hidden text-ellipsis text-[11.6px] text-[#525b68]">
                          Set time and prompt for Zero to run automatically
                        </span>
                      </div>
                      {/* Schedule item */}
                      <div className="w-full rounded-[8px] bg-[#f3f5f8] p-[10px]">
                        <div className="flex flex-col gap-[7px]">
                          <span className="text-[11.6px] font-semibold text-[#15181e]">
                            SEO diagnosis
                          </span>
                          <span className="text-[11.6px] text-[#525b68]">
                            Draft the weekly team report from the last 7 days
                            and save to the shared drive.
                          </span>
                          {/* Toggle switch */}
                          <div className="flex h-[13px] w-[24px] items-center rounded-full bg-[#ef5001] pl-[12px] pr-[1px] py-[1px]">
                            <div className="size-[10.5px] rounded-full bg-white shadow-[0px_7px_10px_-2px_rgba(0,0,0,0.1),0px_3px_4px_-3px_rgba(0,0,0,0.1)]" />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Three bottom benefit items */}
            <div className="grid w-full gap-8 sm:grid-cols-3">
              {[
                {
                  icon: "/assets/agent-intelligence/delegation-icon.svg",
                  title: "Delegation to specialized agents",
                  description:
                    "Zero can spin up sub-agents (e.g., a research agent, a design report agent) to handle tasks in parallel or in the background.",
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
              ].map((item) => (
                <div key={item.title} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <div className="flex size-[30px] items-center justify-center overflow-hidden rounded-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img alt="" src={item.icon} className="size-[22px]" />
                    </div>
                    <h3 className="text-base font-bold leading-6 text-[#14171d]">
                      {item.title}
                    </h3>
                  </div>
                  <p className="text-sm leading-5 text-[#525b68]">
                    {item.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
