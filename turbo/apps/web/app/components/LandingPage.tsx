"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
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
    const t = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  useEffect(() => {
    if (!started) return;
    if (lineIndex >= lines.length) return;

    const currentLine = lines[lineIndex] ?? "";
    if (charIndex < currentLine.length) {
      const t = setTimeout(() => setCharIndex((c) => c + 1), speed);
      return () => clearTimeout(t);
    }
    if (lineIndex < lines.length - 1) {
      const t = setTimeout(() => {
        setLineIndex((l) => l + 1);
        setCharIndex(0);
      }, lineGap);
      return () => clearTimeout(t);
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

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <div className="header-container">
        <Navbar />
      </div>

      <main>
        <section className="relative flex min-h-svh flex-col items-center overflow-hidden px-4 pt-[var(--total-header-height)] sm:px-6">
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
            className="pointer-events-none absolute inset-0 z-[1]"
            style={{
              backgroundImage: "url('/images/landing-bg.png?v=21')",
              backgroundSize: "120% auto",
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

          <div className="relative z-10 mt-[15vh] flex flex-col items-center gap-10">
            <h1 className="drop-shadow-[0_0_40px_rgba(249,249,249,0.8)] text-center text-[36px] font-normal leading-[1.6] tracking-tight sm:text-[48px] md:text-[56px]">
              {lines.map((line, i) => {
                if (i > lineIndex) return null;
                const text = i < lineIndex ? line : line.slice(0, charIndex);
                const showCursor = i === lineIndex && !done;
                return (
                  <span key={i} className="block">
                    {text}
                    {showCursor && (
                      <span className="ml-0.5 inline-block h-10 w-[3px] translate-y-[4px] animate-pulse bg-[hsl(var(--foreground))]" />
                    )}
                  </span>
                );
              })}
            </h1>

            <p className="-mt-4 max-w-md text-center text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
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

            <div className="-mt-4 flex items-center justify-center">
              {[
                "Secure",
                "Memory",
                "Activity logs",
                "On schedule or proactive",
                "100+ connectors",
              ].map((item, i) => (
                <div key={item} className="flex items-center">
                  {i > 0 && (
                    <div className="mx-5 h-3 w-px bg-[hsl(var(--gray-200))]" />
                  )}
                  <span className="text-sm text-[hsl(var(--muted-foreground))]">
                    {item}
                  </span>
                </div>
              ))}
            </div>

            <div className="relative mt-4">
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
              <NextLink
                href="/sign-up"
                className="relative inline-flex items-center justify-center rounded-[10px] bg-[hsl(var(--card))] text-sm font-medium text-[hsl(var(--foreground))] transition-all hover:bg-[hsl(var(--gray-50))]"
                style={{
                  width: "300px",
                  padding: "10px 40px",
                }}
              >
                Join the beta
              </NextLink>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
