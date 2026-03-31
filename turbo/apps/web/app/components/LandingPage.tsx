"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { useUser } from "@clerk/nextjs";
import { getAppUrl } from "../../src/lib/url";
import Navbar from "./Navbar";
import Footer from "./Footer";

const TYPEWRITER_VARIANTS = [
  ["Hey, I'm Zero.", "Your trustworthy AI teammate."],
  ["Hey, I'm Zero.", "Just talk to me like a coworker."],
];

function useTypewriterLines(
  lines: string[],
  speed = 40,
  delay = 600,
  lineGap = 400,
) {
  const [lineIndex, setLineIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      return setStarted(true);
    }, delay);
    return () => {
      return clearTimeout(t);
    };
  }, [delay]);

  useEffect(() => {
    if (!started) return;
    if (lineIndex >= lines.length) return;

    const currentLine = lines[lineIndex] ?? "";
    if (charIndex < currentLine.length) {
      const t = setTimeout(() => {
        return setCharIndex((c) => {
          return c + 1;
        });
      }, speed);
      return () => {
        return clearTimeout(t);
      };
    }
    if (lineIndex < lines.length - 1) {
      const t = setTimeout(() => {
        setLineIndex((l) => {
          return l + 1;
        });
        setCharIndex(0);
      }, lineGap);
      return () => {
        return clearTimeout(t);
      };
    }
    return;
  }, [started, lineIndex, charIndex, lines, speed, lineGap]);

  return {
    lineIndex,
    charIndex,
    done:
      lineIndex >= lines.length - 1 &&
      charIndex >= (lines[lines.length - 1]?.length ?? 0),
  };
}

export default function LandingPage() {
  const [lines] = useState<string[]>(() => {
    const idx = Math.floor(Math.random() * TYPEWRITER_VARIANTS.length);
    return TYPEWRITER_VARIANTS[idx] ?? TYPEWRITER_VARIANTS[0] ?? [];
  });
  const { lineIndex, charIndex, done } = useTypewriterLines(lines);
  const { isSignedIn } = useUser();

  const ctaText = isSignedIn ? "Open app" : "Join the beta";
  const ctaHref = isSignedIn ? getAppUrl() : "/sign-up";

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <div className="header-container">
        <Navbar />
      </div>

      <main>
        <section className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden px-5 pt-[var(--total-header-height)] sm:px-6">
          {/* Paper texture background */}
          <div
            className="pointer-events-none absolute inset-0 z-0"
            style={{
              backgroundImage: "url('/images/paper-bg.png')",
              backgroundSize: "300px",
              backgroundPosition: "center",
              backgroundRepeat: "repeat",
            }}
          />
          {/* Desk illustration */}
          <div
            className="pointer-events-none absolute inset-0 z-[1] bg-[length:200%_auto] sm:bg-[length:150%_auto] md:bg-[length:120%_auto]"
            style={{
              backgroundImage: "url('/images/landing-bg.png?v=21')",
              backgroundPosition: "center bottom",
              backgroundRepeat: "no-repeat",
            }}
          />
          {/* Cover strip to hide top pixel artifacts */}
          <div
            className="pointer-events-none absolute left-0 right-0 z-[2]"
            style={{
              bottom: "calc(100vw * 1271 / 5120 - 1px)",
              height: "20px",
              backgroundImage: "url('/images/paper-bg.png')",
              backgroundSize: "300px",
              backgroundRepeat: "repeat",
            }}
          />

          <div className="relative z-10 -mt-[20vh] flex flex-col items-center gap-6 sm:-mt-[18vh] sm:gap-10">
            <h1 className="drop-shadow-[0_0_40px_rgba(249,249,249,0.8)] text-center text-[28px] font-normal leading-[1.6] tracking-tight sm:text-[48px] md:text-[56px]">
              {lines.map((line, i) => {
                if (i > lineIndex) return null;
                const text = i < lineIndex ? line : line.slice(0, charIndex);
                const showCursor = i === lineIndex && !done;
                return (
                  <span key={i} className="block">
                    {text}
                    {showCursor && (
                      <span className="ml-0.5 inline-block h-7 w-[2px] translate-y-[4px] animate-pulse bg-[hsl(var(--foreground))] sm:h-10 sm:w-[3px]" />
                    )}
                  </span>
                );
              })}
            </h1>

            <p className="max-w-xs text-center text-xs leading-relaxed text-[hsl(var(--muted-foreground))] sm:-mt-4 sm:max-w-md sm:text-sm">
              Do everything in{" "}
              <span className="font-semibold underline decoration-[hsl(var(--primary))] decoration-1 underline-offset-4">
                Slack
              </span>{" "}
              and on the{" "}
              <span className="font-semibold underline decoration-[hsl(var(--primary))] decoration-1 underline-offset-4">
                web
              </span>
              , for individuals and team collaboration. Great ideas come from
              people working together, with each other and with AI.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-y-2 sm:-mt-4 sm:gap-y-2">
              {[
                "Secure",
                "Memory",
                "Activity logs",
                "Proactive",
                "100+ connectors",
              ].map((item, i) => {
                return (
                  <div key={item} className="flex items-center">
                    {i > 0 && (
                      <div className="mx-3 h-3 w-px bg-[hsl(var(--gray-200))] sm:mx-5" />
                    )}
                    <span className="text-xs text-[hsl(var(--muted-foreground))] sm:text-sm">
                      {item}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="relative mt-4 sm:mt-4">
              <svg className="absolute" width="0" height="0">
                <filter id="sketchy">
                  <feTurbulence
                    type="turbulence"
                    baseFrequency="0.03"
                    numOctaves="4"
                    result="noise"
                  />
                  <feDisplacementMap
                    in="SourceGraphic"
                    in2="noise"
                    scale="2"
                    xChannelSelector="R"
                    yChannelSelector="G"
                  />
                </filter>
              </svg>
              <div
                className="absolute -inset-2 rounded-xl opacity-40"
                style={{
                  background:
                    "linear-gradient(135deg, #d4a89f 0%, #c9b88a 20%, #9abba3 40%, #8fa8b8 60%, #a8a0b8 80%, #c4a8a0 100%)",
                  filter: "url(#sketchy-bg)",
                }}
              />
              <svg className="absolute" width="0" height="0">
                <filter id="sketchy-bg">
                  <feTurbulence
                    type="fractalNoise"
                    baseFrequency="0.04"
                    numOctaves="5"
                    result="noise"
                  />
                  <feDisplacementMap
                    in="SourceGraphic"
                    in2="noise"
                    scale="6"
                    xChannelSelector="R"
                    yChannelSelector="G"
                  />
                </filter>
              </svg>
              <div
                className="absolute inset-0 rounded-[10px]"
                style={{
                  border: "1.2px solid hsl(var(--gray-400))",
                  filter: "url(#sketchy)",
                }}
              />
              {isSignedIn ? (
                <a
                  href={ctaHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="relative inline-flex w-[260px] items-center justify-center rounded-[10px] bg-[hsl(var(--card))] text-sm font-medium text-[hsl(var(--foreground))] transition-all hover:bg-[hsl(var(--gray-50))] sm:w-[300px]"
                  style={{ padding: "10px 40px" }}
                >
                  {ctaText}
                </a>
              ) : (
                <NextLink
                  href={ctaHref}
                  className="relative inline-flex w-[260px] items-center justify-center rounded-[10px] bg-[hsl(var(--card))] text-sm font-medium text-[hsl(var(--foreground))] transition-all hover:bg-[hsl(var(--gray-50))] sm:w-[300px]"
                  style={{ padding: "10px 40px" }}
                >
                  {ctaText}
                </NextLink>
              )}
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
