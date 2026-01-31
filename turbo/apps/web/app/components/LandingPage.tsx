"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { IconChevronDown, IconFile } from "@tabler/icons-react";
import Navbar from "./Navbar";
import Footer from "./Footer";

const TYPED_TEXT = "Help me build an agent for tech news aggregation";
const RUN_TYPED_TEXT = {
  hackernews: "Run HackNews Agent and Summarize today's top stories",
  tiktok: "Find TikTok influencers for fitness brands",
  blog: "Generate a blog post about AI agents",
  "daily-report": "Generate daily report for the team",
};

// eslint-disable-next-line complexity
export default function LandingPage() {
  const [activeTab, setActiveTab] = useState<"agents" | "yaml">("agents");
  const [selectedAgent, setSelectedAgent] = useState<
    "hackernews" | "tiktok" | "blog" | "daily-report"
  >("hackernews");
  const [mainTab, setMainTab] = useState<"build" | "run">("run");
  const [buildAnimationStep, setBuildAnimationStep] = useState(-1);
  const [typedText, setTypedText] = useState("");
  const [runAnimationStep, setRunAnimationStep] = useState(-1);
  const [runTypedText, setRunTypedText] = useState("");

  const buildSectionRef = useRef<HTMLDivElement>(null);
  const runSectionRef = useRef<HTMLDivElement>(null);
  const [buildSectionVisible, setBuildSectionVisible] = useState(false);
  const [runSectionVisible, setRunSectionVisible] = useState(false);
  const [copiedHero, setCopiedHero] = useState(false);
  const [copiedEditor, setCopiedEditor] = useState(false);
  const [copiedFooter, setCopiedFooter] = useState(false);

  // Intersection Observer for Build section
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry && entry.isIntersecting && !buildSectionVisible) {
          setBuildSectionVisible(true);
          setBuildAnimationStep(0);
        }
      },
      { threshold: 0.3 },
    );

    if (buildSectionRef.current) {
      observer.observe(buildSectionRef.current);
    }

    return () => observer.disconnect();
  }, [buildSectionVisible]);

  // Intersection Observer for Run section
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry && entry.isIntersecting && !runSectionVisible) {
          setRunSectionVisible(true);
          setRunAnimationStep(0);
        }
      },
      { threshold: 0.3 },
    );

    if (runSectionRef.current) {
      observer.observe(runSectionRef.current);
    }

    return () => observer.disconnect();
  }, [runSectionVisible]);

  // Trigger animations when switching tabs
  useEffect(() => {
    if (mainTab === "build") {
      setBuildAnimationStep(0);
      setBuildSectionVisible(true);
    } else if (mainTab === "run") {
      setRunAnimationStep(0);
      setRunSectionVisible(true);
    }
  }, [mainTab]);

  useEffect(() => {
    const timers: NodeJS.Timeout[] = [];

    // Step 0 -> 1: Show loading then start typing
    if (buildAnimationStep === 0) {
      const timer = setTimeout(() => setBuildAnimationStep(1), 800);
      timers.push(timer);
    }

    // Step 1: Typewriter effect for user input
    else if (buildAnimationStep === 1) {
      let currentIndex = 0;
      const typeInterval = setInterval(() => {
        if (currentIndex <= TYPED_TEXT.length) {
          setTypedText(TYPED_TEXT.slice(0, currentIndex));
          currentIndex++;
        } else {
          clearInterval(typeInterval);
          // Move to next step after typing completes
          const timer = setTimeout(() => setBuildAnimationStep(2), 500);
          timers.push(timer);
        }
      }, 50);
      timers.push(typeInterval as unknown as NodeJS.Timeout);
    }

    // Progressive reveal of conversation
    else if (buildAnimationStep === 2) {
      const timer = setTimeout(() => setBuildAnimationStep(3), 1000);
      timers.push(timer);
    } else if (buildAnimationStep === 3) {
      const timer = setTimeout(() => setBuildAnimationStep(4), 1200);
      timers.push(timer);
    } else if (buildAnimationStep === 4) {
      const timer = setTimeout(() => setBuildAnimationStep(5), 1000);
      timers.push(timer);
    } else if (buildAnimationStep === 5) {
      const timer = setTimeout(() => setBuildAnimationStep(6), 800);
      timers.push(timer);
    } else if (buildAnimationStep === 6) {
      const timer = setTimeout(() => setBuildAnimationStep(7), 1000);
      timers.push(timer);
    } else if (buildAnimationStep === 7) {
      const timer = setTimeout(() => setBuildAnimationStep(8), 800);
      timers.push(timer);
    }

    return () => timers.forEach(clearTimeout);
  }, [buildAnimationStep]);

  // Reset run animation when switching agents
  useEffect(() => {
    if (runSectionVisible) {
      setRunAnimationStep(0);
      setRunTypedText("");
    }
  }, [selectedAgent, runSectionVisible]);

  // Run agent animation
  useEffect(() => {
    const timers: NodeJS.Timeout[] = [];

    // Step 0 -> 1: Start typing user command
    if (runAnimationStep === 0) {
      const timer = setTimeout(() => setRunAnimationStep(1), 800);
      timers.push(timer);
    }

    // Step 1: Typewriter effect for user command
    else if (runAnimationStep === 1) {
      const currentText = RUN_TYPED_TEXT[selectedAgent];
      let currentIndex = 0;
      const typeInterval = setInterval(() => {
        if (currentIndex <= currentText.length) {
          setRunTypedText(currentText.slice(0, currentIndex));
          currentIndex++;
        } else {
          clearInterval(typeInterval);
          const timer = setTimeout(() => setRunAnimationStep(2), 500);
          timers.push(timer);
        }
      }, 50);
      timers.push(typeInterval as unknown as NodeJS.Timeout);
    }

    // Progressive reveal of execution
    else if (runAnimationStep === 2) {
      const timer = setTimeout(() => setRunAnimationStep(3), 1000);
      timers.push(timer);
    } else if (runAnimationStep === 3) {
      const timer = setTimeout(() => setRunAnimationStep(4), 1500);
      timers.push(timer);
    } else if (runAnimationStep === 4) {
      const timer = setTimeout(() => setRunAnimationStep(5), 2000);
      timers.push(timer);
    } else if (runAnimationStep === 5) {
      const timer = setTimeout(() => setRunAnimationStep(6), 1500);
      timers.push(timer);
    }

    return () => timers.forEach(clearTimeout);
  }, [runAnimationStep, selectedAgent]);

  return (
    <div className="min-h-screen">
      {/* Particles Background */}
      <div
        className="particles"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
        }}
      >
        {[...Array(12)].map((_, i) => {
          const size = i % 3 === 0 ? "large" : i % 3 === 1 ? "medium" : "small";
          return <div key={i} className={`particle particle-${size}`} />;
        })}
      </div>

      <Navbar />

      <main className="flex flex-col items-center w-full pt-[128px]">
        {/* Hero Section */}
        <section className="w-full max-w-[1440px] px-8 pb-0">
          <div className="max-w-[1200px] mx-auto">
            {/* Hero Content */}
            <div className="flex flex-col items-center gap-[40px] mb-16">
              {/* 3D Rotating Cube */}
              <div
                style={{
                  width: "80px",
                  height: "80px",
                  perspective: "500px",
                  margin: "0 auto 24px",
                }}
              >
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    position: "relative",
                    transformStyle: "preserve-3d",
                    animation: "rotateCube 12s infinite linear",
                  }}
                >
                  {/* Front */}
                  <div
                    style={{
                      position: "absolute",
                      width: "80px",
                      height: "80px",
                      background:
                        "linear-gradient(135deg, rgba(237, 78, 1, 0.55), rgba(237, 78, 1, 0.25))",
                      border: "3px solid rgba(237, 78, 1, 0.5)",
                      backdropFilter: "blur(10px)",
                      transform: "translateZ(40px)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 0 30px rgba(237, 78, 1, 0.7)",
                    }}
                  />
                  {/* Back */}
                  <div
                    style={{
                      position: "absolute",
                      width: "80px",
                      height: "80px",
                      background:
                        "linear-gradient(135deg, rgba(237, 78, 1, 0.5), rgba(237, 78, 1, 0.2))",
                      border: "3px solid rgba(237, 78, 1, 0.4)",
                      backdropFilter: "blur(10px)",
                      transform: "translateZ(-40px) rotateY(180deg)",
                      boxShadow: "0 0 25px rgba(237, 78, 1, 0.6)",
                    }}
                  />
                  {/* Right */}
                  <div
                    style={{
                      position: "absolute",
                      width: "80px",
                      height: "80px",
                      background:
                        "linear-gradient(135deg, rgba(237, 78, 1, 0.5), rgba(237, 78, 1, 0.2))",
                      border: "3px solid rgba(237, 78, 1, 0.45)",
                      backdropFilter: "blur(10px)",
                      transform: "rotateY(90deg) translateZ(40px)",
                      boxShadow: "0 0 27px rgba(237, 78, 1, 0.65)",
                    }}
                  />
                  {/* Left */}
                  <div
                    style={{
                      position: "absolute",
                      width: "80px",
                      height: "80px",
                      background:
                        "linear-gradient(135deg, rgba(237, 78, 1, 0.5), rgba(237, 78, 1, 0.2))",
                      border: "3px solid rgba(237, 78, 1, 0.45)",
                      backdropFilter: "blur(10px)",
                      transform: "rotateY(-90deg) translateZ(40px)",
                      boxShadow: "0 0 27px rgba(237, 78, 1, 0.65)",
                    }}
                  />
                  {/* Top */}
                  <div
                    style={{
                      position: "absolute",
                      width: "80px",
                      height: "80px",
                      background:
                        "linear-gradient(135deg, rgba(237, 78, 1, 0.65), rgba(237, 78, 1, 0.3))",
                      border: "3px solid rgba(237, 78, 1, 0.55)",
                      backdropFilter: "blur(10px)",
                      transform: "rotateX(90deg) translateZ(40px)",
                      boxShadow: "0 0 30px rgba(237, 78, 1, 0.7)",
                    }}
                  />
                  {/* Bottom */}
                  <div
                    style={{
                      position: "absolute",
                      width: "80px",
                      height: "80px",
                      background:
                        "linear-gradient(135deg, rgba(237, 78, 1, 0.45), rgba(237, 78, 1, 0.2))",
                      border: "3px solid rgba(237, 78, 1, 0.4)",
                      backdropFilter: "blur(10px)",
                      transform: "rotateX(-90deg) translateZ(40px)",
                      boxShadow: "0 0 25px rgba(237, 78, 1, 0.6)",
                    }}
                  />
                </div>
              </div>
              <style>{`
                @keyframes rotateCube {
                  from {
                    transform: rotateX(45deg) rotateY(0deg);
                  }
                  to {
                    transform: rotateX(45deg) rotateY(360deg);
                  }
                }
              `}</style>

              <h1 className="flex flex-col justify-center font-medium text-center text-[24px] sm:text-[30px] md:text-[36px] leading-[1.2] text-foreground tracking-normal px-4">
                <span className="block mb-0">
                  Build AI agents with natural language.
                </span>
                <span className="block">Run them 24/7 in the cloud.</span>
              </h1>

              {/* CTA Section - More compact */}
              <div className="flex flex-col items-center gap-[20px] w-full px-4">
                {/* Install Command with description */}
                <div className="flex flex-col items-center gap-[8px] w-full max-w-[566px]">
                  <div className="bg-card border border-[#f5eae1] dark:border-[#2f2f32] border-solid rounded-[12px] px-[16px] sm:px-[24px] py-[12px] w-full flex gap-[12px] sm:gap-[32px] items-center justify-center relative">
                    <code
                      className="flex-1 font-normal leading-[1.4] sm:leading-[40px] text-[14px] sm:text-[18px] text-foreground break-all sm:whitespace-pre-wrap"
                      style={{
                        fontFamily:
                          'var(--font-jetbrains-mono, "JetBrains Mono", monospace)',
                      }}
                    >
                      npm install -g @vm0/cli && vm0 onboard
                    </code>
                    <button
                      onClick={() => {
                        navigator.clipboard
                          .writeText("npm install -g @vm0/cli && vm0 onboard")
                          .catch(() => {});
                        setCopiedHero(true);
                        setTimeout(() => setCopiedHero(false), 2000);
                      }}
                      className="bg-[#f0ebe5] dark:bg-[#292a2e] hover:bg-[#e5dfd8] dark:hover:bg-[#3a3a3e] h-[36px] w-[36px] sm:h-[40px] sm:w-[40px] flex items-center justify-center rounded-[10px] transition-colors shrink-0"
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="sm:w-[20px] sm:h-[20px]"
                      >
                        <rect
                          x="9"
                          y="9"
                          width="13"
                          height="13"
                          rx="2"
                          ry="2"
                        />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                    {copiedHero && (
                      <div className="absolute -top-[50px] right-[0px] bg-[#231f1b] text-white px-[12px] py-[6px] rounded-[6px] text-[14px] whitespace-nowrap">
                        Copied
                      </div>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground text-center px-4">
                    Throw it in your terminal and vibe
                  </p>
                </div>

                {/* Divider with OR */}
                <div className="w-full max-w-[566px] flex items-center gap-4">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-sm text-muted-foreground">or</span>
                  <div className="flex-1 h-px bg-border" />
                </div>

                {/* CTA Button */}
                <div className="w-full max-w-[566px]">
                  <Link
                    href="/sign-up"
                    className="bg-[#ed4e01] hover:bg-[#ff6a1f] !text-white w-full px-[24px] py-[12px] rounded-[10px] flex items-center justify-center transition-colors"
                  >
                    <span className="font-medium leading-[28px] text-[16px] sm:text-[18px] tracking-normal !text-white">
                      Get started
                    </span>
                  </Link>
                </div>
              </div>
            </div>

            {/* Agent Tabs */}
            <div className="flex gap-[12px] items-center mb-[30px] justify-center">
              <button
                onClick={() => setMainTab("run")}
                className={`px-[14px] py-[6px] rounded-[6px] text-[14px] font-normal transition-all border ${
                  mainTab === "run"
                    ? "bg-[#fef5ee] dark:bg-[#292a2e] text-primary border-[#f5eae1] dark:border-[#2f2f32]"
                    : "text-muted-foreground hover:text-primary hover:bg-[#fef5ee] dark:hover:bg-[#292a2e] border-transparent hover:border-[#f5eae1] dark:hover:border-[#2f2f32]"
                }`}
              >
                Run an agent
              </button>
              <button
                onClick={() => setMainTab("build")}
                className={`px-[14px] py-[6px] rounded-[6px] text-[14px] font-normal transition-all border ${
                  mainTab === "build"
                    ? "bg-[#fef5ee] dark:bg-[#292a2e] text-primary border-[#f5eae1] dark:border-[#2f2f32]"
                    : "text-muted-foreground hover:text-primary hover:bg-[#fef5ee] dark:hover:bg-[#292a2e] border-transparent hover:border-[#f5eae1] dark:hover:border-[#2f2f32]"
                }`}
              >
                Build an agent
              </button>
            </div>

            {/* Run an agent */}
            {mainTab === "run" && (
              <div
                ref={runSectionRef}
                className="flex flex-col gap-[30px] mb-20 px-4"
              >
                <div className="text-center">
                  <h2 className="text-[24px] sm:text-[30px] md:text-[36px] font-medium leading-[1.2] text-foreground mb-4">
                    Run an agent
                  </h2>
                  <p className="text-[14px] sm:text-[16px] leading-[1.5] text-foreground">
                    Execute your agents instantly, powered by workflows defined
                    in natural language.
                  </p>
                  <p className="text-[14px] sm:text-[16px] leading-[1.5] text-foreground">
                    Schedule recurring runs or execute on demand, with full
                    visibility and control.
                  </p>
                </div>

                <div
                  className="rounded-[6px] pt-[20px] pb-[20px] sm:pb-[30px] px-[16px] sm:px-[30px] flex items-center justify-center"
                  style={{
                    backgroundImage:
                      "linear-gradient(137.478deg, #E8A145 0.82464%, #F8732A 45.285%, #933803 99.384%)",
                  }}
                >
                  <div className="flex flex-col lg:flex-row gap-[16px] sm:gap-[24px] items-stretch lg:items-end w-full max-w-[1124px] mx-auto">
                    {/* Terminal - Left Side */}
                    <div className="flex-1 bg-white dark:bg-[#19191b] border-[0.5px] border-border rounded-[12px] shadow-[0px_25px_50px_-12px_rgba(0,0,0,0.25)] overflow-hidden h-[422px] flex flex-col">
                      {/* Terminal Header */}
                      <div className="bg-[#f9f4ef] dark:bg-[#292a2e] p-[8px] flex gap-[76px] items-center shadow-[0px_0.5px_0px_0px_#d2d2d2] dark:shadow-[0px_0.5px_0px_0px_#2f2f32]">
                        <div className="flex gap-1.5 w-[39px] h-[9px]">
                          <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
                          <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                        </div>
                        <p
                          className="text-[12px] text-center font-medium w-[354px]"
                          style={{ fontFamily: "var(--font-noto-sans)" }}
                        >
                          <span className="text-[#827d77]">~/work</span>
                          <span className="text-foreground">
                            {" "}
                            * VM0 Agent ▸ Claude Code
                          </span>
                        </p>
                      </div>

                      {/* Terminal Content */}
                      <div
                        className="flex-1 p-[20px] overflow-y-auto"
                        style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                      >
                        <div className="flex gap-[10px] items-start text-[12px] leading-[16px]">
                          <div className="flex gap-[4px] items-center">
                            <div className="text-black dark:text-white">
                              <p className="m-0"> *</p>
                              <p className="m-0">*</p>
                              <p className="m-0"> *</p>
                            </div>
                            <Image
                              src="/landing/vector-logo.svg"
                              alt="VM0"
                              width="65"
                              height="40"
                            />
                            <div className="text-black dark:text-white">
                              <p className="m-0">*</p>
                              <p className="m-0"> *</p>
                              <p className="m-0">*</p>
                            </div>
                          </div>
                          <div className="text-[11px]">
                            <p className="m-0">
                              <span className="font-bold">Claude Code</span>{" "}
                              v2.0.76
                            </p>
                            <p className="m-0 text-[#827d77]">
                              Sonnet 4.5 · Claude API
                            </p>
                            <p className="m-0 text-[#827d77]">/Users/ming</p>
                          </div>
                        </div>

                        {selectedAgent === "hackernews" && (
                          <div className="mt-[10px] text-[12px] leading-[16px] space-y-0 font-light">
                            {/* Step 1: User input with typewriter effect */}
                            {runAnimationStep >= 1 && (
                              <p className="m-0 text-secondary-foreground">
                                &gt; {runTypedText}
                                {runAnimationStep === 1 && (
                                  <span className="animate-pulse">█</span>
                                )}
                              </p>
                            )}

                            {runAnimationStep >= 2 && (
                              <p className="m-0">&nbsp;</p>
                            )}

                            {/* Step 2: Agent response */}
                            {runAnimationStep >= 2 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    I&apos;ll run the 201-hackernews agent to
                                    summarize today&apos;s top stories. This may
                                    take a few minutes.
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 3: Bash command and run details */}
                            {runAnimationStep >= 3 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-[#3b82f6]">Bash</span>
                                  <span className="text-secondary-foreground">
                                    (
                                  </span>
                                  <span className="text-[#06b6d4]">
                                    vm0 run 201-hackernews &quot;Summarize
                                    today&apos;s top stories&quot;
                                  </span>
                                  <span className="text-secondary-foreground">
                                    ) timeout: 5m 0s
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  ⎿ ▶ Run started
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Run ID:{" "}
                                  <span className="text-[#06b6d4]">
                                    882337d4-44f3-4d73-b6a0-3a59c100b70d
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Sandbox:{" "}
                                  <span className="text-[#06b6d4]">
                                    iucshvzk17eyv7vwvxsah
                                  </span>
                                </p>
                                <p className="m-0 text-[#6b7280]">
                                  {" "}
                                  … +641 lines (ctrl+o to expand)
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 4: Success message and results summary */}
                            {runAnimationStep >= 4 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-[#22c55e]">
                                    Perfect! Your 201-hackernews agent ran
                                    successfully! 🎉
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-secondary-foreground">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    Results Summary
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  The agent analyzed today&apos;s top 10
                                  HackerNews stories and identified 2 major
                                  AI-related articles:
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 5: First result (Moltbook) */}
                            {runAnimationStep >= 5 && (
                              <>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    1. Moltbook
                                  </span>{" "}
                                  (586 points)
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - A social network built specifically for AI
                                  agents
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Agents can post, comment, vote, and build
                                  reputation
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Humans can observe, but agents are the
                                  primary users
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Represents emerging infrastructure for
                                  autonomous agent-to-agent communication
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - 🔗{" "}
                                  <span className="text-[#06b6d4]">
                                    https://www.moltbook.com/
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 6: Second result and run details */}
                            {runAnimationStep >= 6 && (
                              <>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    2. OpenClaw
                                  </span>{" "}
                                  (289 points)
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Open-source AI agent platform that runs
                                  locally
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Full data sovereignty - your data stays on
                                  your machine
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Integrates with WhatsApp, Telegram, Discord,
                                  Slack, Teams, Twitch, Google Chat
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Went through 3 name changes (Clawd → Moltbot
                                  → OpenClaw) due to trademark issues
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Recent focus on security with 34 security
                                  commits
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - 🔗{" "}
                                  <span className="text-[#06b6d4]">
                                    https://openclaw.ai/blog/introducing-openclaw
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    Output File
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  The agent created{" "}
                                  <span className="text-[#06b6d4]">
                                    content.md
                                  </span>{" "}
                                  with:
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Detailed summaries of both stories
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - A ready-to-post X/Twitter thread format
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    Run Details:
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Duration: 66.2 seconds
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Cost: $0.1850
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Run ID:{" "}
                                  <span className="text-[#06b6d4]">
                                    882337d4-44f3-4d73-b6a0-3a59c100b70d
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  You can view the full logs with:
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  <span className="text-[#06b6d4]">
                                    vm0 logs
                                    882337d4-44f3-4d73-b6a0-3a59c100b70d
                                  </span>
                                </p>
                              </>
                            )}
                          </div>
                        )}

                        {selectedAgent === "tiktok" && (
                          <div className="mt-[10px] text-[12px] leading-[16px] space-y-0 font-light">
                            {/* Step 1: User input with typewriter effect */}
                            {runAnimationStep >= 1 && (
                              <p className="m-0 text-secondary-foreground">
                                &gt; {runTypedText}
                                {runAnimationStep === 1 && (
                                  <span className="animate-pulse">█</span>
                                )}
                              </p>
                            )}

                            {runAnimationStep >= 2 && (
                              <p className="m-0">&nbsp;</p>
                            )}

                            {/* Step 2: Agent response */}
                            {runAnimationStep >= 2 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    I&apos;ll help you discover TikTok
                                    influencers. Let me run the
                                    tiktok-influencer agent.
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 3: Bash command and run start */}
                            {runAnimationStep >= 3 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-[#3b82f6]">Bash</span>
                                  <span className="text-secondary-foreground">
                                    (
                                  </span>
                                  <span className="text-[#06b6d4]">
                                    vm0 run tiktok-influencer
                                  </span>
                                  <span className="text-secondary-foreground">
                                    ) timeout: 8m 0s
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  ⎿ ▶ Run started
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Run ID:{" "}
                                  <span className="text-[#06b6d4]">
                                    f5a92e18-3d4c-4b89-a1e2-9c7f8b2d4e61
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Sandbox:{" "}
                                  <span className="text-[#06b6d4]">
                                    xk9dfj2n8pqwer5tyvlmz
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 4: All phases */}
                            {runAnimationStep >= 4 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Phase 1: Gathering business information...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Search Keyword:{" "}
                                  <span className="text-foreground">
                                    fitness
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Industry:{" "}
                                  <span className="text-foreground">
                                    Health & Wellness
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Notion Database ID:{" "}
                                  <span className="text-[#06b6d4]">
                                    a8f3e9c...
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Phase 2: Discovering TikTok profiles...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Scraping TikTok for &quot;fitness&quot;
                                  creators (this takes 2-3 minutes)
                                </p>
                                <p className="m-0 text-[#6b7280]">
                                  {" "}
                                  … +124 lines (ctrl+o to expand)
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Phase 3: Storing data in Notion...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  ✓ Added 15 influencers to database
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Phase 4: Analyzing relevance...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Evaluating each influencer based on followers,
                                  content, and profile description
                                </p>
                                <p className="m-0 text-[#6b7280]">
                                  {" "}
                                  … +89 lines (ctrl+o to expand)
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 5: Success and results summary */}
                            {runAnimationStep >= 5 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-[#22c55e]">
                                    Success! TikTok influencer discovery
                                    completed! 🎉
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-secondary-foreground">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    Results Summary
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Total Analyzed:{" "}
                                  <span className="text-foreground">
                                    15 influencers
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Highly Relevant:{" "}
                                  <span className="text-[#22c55e]">
                                    8 influencers
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Data Stored:{" "}
                                  <span className="text-[#06b6d4]">
                                    Notion Database
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    Top Influencer:
                                  </span>{" "}
                                  @fitnesswithkayla (245K followers)
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Strong fitness content with workout routines,
                                  nutrition tips, and motivational posts.
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    Output File:
                                  </span>{" "}
                                  <span className="text-[#06b6d4]">
                                    influencer-report.md
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 6: Run details */}
                            {runAnimationStep >= 6 && (
                              <>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    Run Details:
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Duration: 4m 32s
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Cost: $0.4250
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Run ID:{" "}
                                  <span className="text-[#06b6d4]">
                                    f5a92e18-3d4c-4b89-a1e2-9c7f8b2d4e61
                                  </span>
                                </p>
                              </>
                            )}
                          </div>
                        )}

                        {selectedAgent === "blog" && (
                          <div className="mt-[10px] text-[12px] leading-[16px] space-y-0 font-light">
                            {/* Step 1: User input with typewriter effect */}
                            {runAnimationStep >= 1 && (
                              <p className="m-0 text-secondary-foreground">
                                &gt; {runTypedText}
                                {runAnimationStep === 1 && (
                                  <span className="animate-pulse">█</span>
                                )}
                              </p>
                            )}

                            {runAnimationStep >= 2 && (
                              <p className="m-0">&nbsp;</p>
                            )}

                            {/* Step 2: Agent response */}
                            {runAnimationStep >= 2 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    I&apos;ll create an SEO-optimized blog
                                    article. Let me run the content-farm agent.
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 3: Bash command and run start */}
                            {runAnimationStep >= 3 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-[#3b82f6]">Bash</span>
                                  <span className="text-secondary-foreground">
                                    (
                                  </span>
                                  <span className="text-[#06b6d4]">
                                    vm0 run content-farm &quot;AI agents&quot;
                                  </span>
                                  <span className="text-secondary-foreground">
                                    ) timeout: 10m 0s
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  ⎿ ▶ Run started
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Run ID:{" "}
                                  <span className="text-[#06b6d4]">
                                    d8b3f2c9-5e7a-4d91-b2c3-8f9e1a7d5c42
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Sandbox:{" "}
                                  <span className="text-[#06b6d4]">
                                    nq7wjk3m9rxpvt4ylzbhd
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 4: Phases 1-4 */}
                            {runAnimationStep >= 4 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Phase 1: Gathering news from RSS feeds...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Fetching from Hacker News, TechCrunch, Wired,
                                  Ars Technica, The Verge
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  ✓ Found 47 recent articles
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Phase 2: Filtering and selecting articles...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Selected 4 articles matching &quot;AI
                                  agents&quot; topic
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Phase 3: Creating SEO title...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Generated 5 title candidates
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Selected:{" "}
                                  <span className="text-foreground">
                                    &quot;AI Agents in 2025: How Autonomous
                                    Systems Are Changing Software
                                    Development&quot;
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Phase 4: Building outline...
                                  </span>
                                </p>
                                <p className="m-0 text-[#6b7280]">
                                  {" "}
                                  … +32 lines (ctrl+o to expand)
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 5: Phases 5-8 and success */}
                            {runAnimationStep >= 5 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Phase 5: Writing article...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Writing 1,250 word article with conversational
                                  tone
                                </p>
                                <p className="m-0 text-[#6b7280]">
                                  {" "}
                                  … +156 lines (ctrl+o to expand)
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Phase 6: Generating featured image...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  ✓ Image generated and saved
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Phase 7: Preparing output...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  ✓ Saved to output folder
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Phase 8: Publishing to Dev.to...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  ✓ Article published successfully
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-[#22c55e]">
                                    Success! Blog article published! 🎉
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 6: Article details and run details */}
                            {runAnimationStep >= 6 && (
                              <>
                                <p className="m-0 text-secondary-foreground">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    Article Details
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Title:{" "}
                                  <span className="text-foreground">
                                    AI Agents in 2025: How Autonomous Systems
                                    Are Changing Software Development
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Word Count:{" "}
                                  <span className="text-foreground">
                                    1,250 words
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Citations:{" "}
                                  <span className="text-foreground">
                                    4 sources
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Dev.to URL:{" "}
                                  <span className="text-[#06b6d4]">
                                    https://dev.to/ai-agents-2025-software-dev
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    Run Details:
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Duration: 7m 18s
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Cost: $0.7850
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Run ID:{" "}
                                  <span className="text-[#06b6d4]">
                                    d8b3f2c9-5e7a-4d91-b2c3-8f9e1a7d5c42
                                  </span>
                                </p>
                              </>
                            )}
                          </div>
                        )}

                        {selectedAgent === "daily-report" && (
                          <div className="mt-[10px] text-[12px] leading-[16px] space-y-0 font-light">
                            {/* Step 1: User input with typewriter effect */}
                            {runAnimationStep >= 1 && (
                              <p className="m-0 text-secondary-foreground">
                                &gt; {runTypedText}
                                {runAnimationStep === 1 && (
                                  <span className="animate-pulse">█</span>
                                )}
                              </p>
                            )}

                            {runAnimationStep >= 2 && (
                              <p className="m-0">&nbsp;</p>
                            )}

                            {/* Step 2: Agent response */}
                            {runAnimationStep >= 2 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    I&apos;ll gather data from multiple sources
                                    and generate today&apos;s report.
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 3: Bash command and run start */}
                            {runAnimationStep >= 3 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-[#3b82f6]">Bash</span>
                                  <span className="text-secondary-foreground">
                                    (
                                  </span>
                                  <span className="text-[#06b6d4]">
                                    vm0 run daily-data-report
                                  </span>
                                  <span className="text-secondary-foreground">
                                    ) timeout: 5m 0s
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  ⎿ ▶ Run started
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Run ID:{" "}
                                  <span className="text-[#06b6d4]">
                                    a9c2e4f8-1b3d-4c7a-9e2f-5d8b3a7c9e41
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Sandbox:{" "}
                                  <span className="text-[#06b6d4]">
                                    pk8vmj4n2swqxt6ylazhc
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 4: All data collection phases */}
                            {runAnimationStep >= 4 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Collecting GitHub repository metrics...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Stars:{" "}
                                  <span className="text-foreground">
                                    2,847
                                  </span>{" "}
                                  (+23 yesterday)
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Forks:{" "}
                                  <span className="text-foreground">156</span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Open Issues:{" "}
                                  <span className="text-foreground">34</span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Fetching Plausible analytics...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Visitors:{" "}
                                  <span className="text-foreground">1,245</span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Pageviews:{" "}
                                  <span className="text-foreground">3,892</span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Bounce Rate:{" "}
                                  <span className="text-foreground">42.3%</span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Gathering user data from Clerk...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Total Users:{" "}
                                  <span className="text-foreground">8,234</span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  New Registrations:{" "}
                                  <span className="text-foreground">47</span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Analyzing code changes...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Commits:{" "}
                                  <span className="text-foreground">12</span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  Files Changed:{" "}
                                  <span className="text-foreground">28</span>
                                </p>
                                <p className="m-0 text-[#6b7280]">
                                  {" "}
                                  … +45 lines (ctrl+o to expand)
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-secondary-foreground">
                                    Checking Notion document updates...
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  ✓ Found 8 page modifications
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 5: Success and report summary */}
                            {runAnimationStep >= 5 && (
                              <>
                                <p className="m-0">
                                  <span className="text-[#22c55e]">⏺</span>{" "}
                                  <span className="text-[#22c55e]">
                                    Success! Daily report generated! 🎉
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-secondary-foreground">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    Report Summary
                                  </span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Report Date:{" "}
                                  <span className="text-foreground">
                                    2025-01-30
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Data Sources:{" "}
                                  <span className="text-foreground">
                                    6 integrated
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Output File:{" "}
                                  <span className="text-[#06b6d4]">
                                    daily-report-2025-01-30.md
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Slack Notification:{" "}
                                  <span className="text-[#22c55e]">Sent</span>
                                </p>
                                <p className="m-0">&nbsp;</p>
                              </>
                            )}

                            {/* Step 6: Run details */}
                            {runAnimationStep >= 6 && (
                              <>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  <span className="text-foreground font-medium">
                                    Run Details:
                                  </span>
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Duration: 2m 45s
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Cost: $0.3150
                                </p>
                                <p className="m-0 text-[#827d77]">
                                  {" "}
                                  - Run ID:{" "}
                                  <span className="text-[#06b6d4]">
                                    a9c2e4f8-1b3d-4c7a-9e2f-5d8b3a7c9e41
                                  </span>
                                </p>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Code Editor - Right Side */}
                    <div className="flex-1 flex flex-col shadow-[0px_25px_50px_0px_rgba(0,0,0,0.25)] h-[422px]">
                      {/* Editor Header with Tabs */}
                      <div className="bg-[#f9f4ef] dark:bg-[#292a2e] border-b border-border h-[44px] flex items-center gap-[6px] px-[12px] py-[6px] rounded-tl-[8px] rounded-tr-[8px] relative">
                        <div className="flex-1 flex gap-[6px] items-center pl-[4px]">
                          <div
                            onClick={() => setActiveTab("agents")}
                            className={`flex gap-[6px] items-center px-[6px] py-[4px] rounded-[6px] cursor-pointer transition-all border ${
                              activeTab === "agents"
                                ? "bg-[rgba(255,255,255,0.6)] border-border"
                                : "border-transparent hover:bg-[rgba(255,255,255,0.3)] hover:border-border"
                            }`}
                          >
                            <IconFile
                              size={14.4}
                              stroke={1.2}
                              className="text-foreground"
                            />
                            <p className="text-[14px] font-medium leading-[20px] text-foreground">
                              AGENTS.MD
                            </p>
                          </div>
                          <div
                            onClick={() => setActiveTab("yaml")}
                            className={`flex gap-[6px] items-center px-[6px] py-[4px] rounded-[6px] cursor-pointer transition-all border ${
                              activeTab === "yaml"
                                ? "bg-[rgba(255,255,255,0.6)] border-border"
                                : "border-transparent hover:bg-[rgba(255,255,255,0.3)] hover:border-border"
                            }`}
                          >
                            <IconFile
                              size={14.4}
                              stroke={1.2}
                              className="text-foreground"
                            />
                            <p className="text-[14px] font-medium leading-[20px] text-foreground">
                              vm0.yaml
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            const content =
                              activeTab === "agents"
                                ? `Agent Instructions\n\nYou are a specialized agent for ${selectedAgent}.`
                                : `name: ${selectedAgent}\nversion: 1.0.0`;
                            navigator.clipboard
                              .writeText(content)
                              .catch(() => {});
                            setCopiedEditor(true);
                            setTimeout(() => setCopiedEditor(false), 2000);
                          }}
                          className="bg-[#f9f4ef] dark:bg-[#292a2e] hover:bg-[#f0ebe5] dark:hover:bg-[#3a3a3e] rounded-[10px] w-[40px] h-[36px] flex items-center justify-center transition-colors"
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <rect
                              x="9"
                              y="9"
                              width="13"
                              height="13"
                              rx="2"
                              ry="2"
                            />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                        {copiedEditor && (
                          <div className="absolute -top-[50px] right-[12px] bg-[#231f1b] text-white px-[12px] py-[6px] rounded-[6px] text-[14px] whitespace-nowrap z-10">
                            Copied
                          </div>
                        )}
                      </div>

                      {/* Editor Content */}
                      <div className="flex-1 bg-white dark:bg-[#19191b] p-[16px] overflow-y-auto rounded-bl-[12px] rounded-br-[12px]">
                        {selectedAgent === "hackernews" &&
                          activeTab === "agents" && (
                            <div
                              className="text-[14px] leading-[20px]"
                              style={{ fontFamily: "var(--font-noto-sans)" }}
                            >
                              <p className="m-0 font-semibold text-[18px] leading-[26px]">
                                Agent Instructions
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0">
                                You are a Hacker News AI content curator.
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-semibold text-[15px] leading-[22px]">
                                Workflow
                              </p>
                              <ul className="list-disc ml-[20px] m-0">
                                <li className="m-0">
                                  Read the top 10 articles on Hacker News
                                </li>
                                <li className="m-0">
                                  Identify AI-related content
                                </li>
                                <li className="m-0">
                                  Extract key ideas and patterns
                                </li>
                                <li className="m-0">
                                  Summarize the findings in an X (Twitter) post
                                  format
                                </li>
                                <li className="m-0">
                                  Write the output to `content.md`
                                </li>
                              </ul>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-semibold text-[15px] leading-[22px]">
                                Guidelines
                              </p>
                              <ul className="list-disc ml-[20px] m-0">
                                <li className="m-0">
                                  Focus on signal over noise
                                </li>
                                <li className="m-0">
                                  Keep summaries concise and skimmable
                                </li>
                                <li className="m-0">
                                  Use a neutral, non-promotional tone
                                </li>
                              </ul>
                            </div>
                          )}

                        {selectedAgent === "hackernews" &&
                          activeTab === "yaml" && (
                            <div
                              className="text-[13px] leading-[18px] whitespace-pre-wrap break-words"
                              style={{
                                fontFamily: "var(--font-jetbrains-mono)",
                              }}
                            >
                              <p className="m-0">
                                <span className="text-[#3b82f6]">version</span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-[#22c55e]">
                                  &quot;1.0&quot;
                                </span>
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0">
                                <span className="text-[#3b82f6]">agents</span>
                                <span className="text-[#827d77]">:</span>
                              </p>
                              <p className="m-0">
                                {"  "}
                                <span className="text-[#3b82f6]">
                                  201-hackernews
                                </span>
                                <span className="text-[#827d77]">:</span>
                              </p>
                              <p className="m-0">
                                {"    "}
                                <span className="text-[#3b82f6]">
                                  framework
                                </span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-foreground">
                                  claude-code
                                </span>
                              </p>
                              <p className="m-0">
                                {"    "}
                                <span className="text-[#3b82f6]">
                                  instructions
                                </span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-foreground">
                                  AGENTS.md
                                </span>
                              </p>
                              <p className="m-0">
                                {"    "}
                                <span className="text-[#3b82f6]">skills</span>
                                <span className="text-[#827d77]">:</span>
                              </p>
                              <p className="m-0">
                                {"      "}
                                <span className="text-[#827d77]">-</span>{" "}
                                <span className="text-[#06b6d4]">
                                  https://github.com/vm0-ai/vm0-skills/tree/main/hackernews
                                </span>
                              </p>
                            </div>
                          )}

                        {selectedAgent === "tiktok" &&
                          activeTab === "agents" && (
                            <div
                              className="text-[14px] leading-[20px]"
                              style={{ fontFamily: "var(--font-noto-sans)" }}
                            >
                              <p className="m-0 font-semibold text-[18px] leading-[26px]">
                                TikTok Influencer Discovery Agent
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0">
                                You are a TikTok influencer discovery and
                                analysis expert. You help businesses find the
                                most relevant TikTok influencers for
                                collaboration based on their industry and
                                requirements.
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-semibold text-[15px] leading-[22px]">
                                Workflow
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-medium text-[14px] leading-[20px]">
                                Phase 1: Gather Business Information
                              </p>
                              <ul className="list-disc ml-[20px] m-0">
                                <li className="m-0">
                                  Search Keyword: What type of content/niche to
                                  search for
                                </li>
                                <li className="m-0">
                                  About Your Business: Brief description
                                </li>
                                <li className="m-0">
                                  Industry: The industry the business operates
                                  in
                                </li>
                                <li className="m-0">
                                  Notion Database ID: To store results
                                </li>
                              </ul>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-medium text-[14px] leading-[20px]">
                                Phase 2: Discover TikTok Influencers
                              </p>
                              <p className="m-0">
                                Search for TikTok profiles matching the keyword.
                                The scraping process takes 2-3 minutes to
                                complete.
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-medium text-[14px] leading-[20px]">
                                Phase 3: Store Raw Data in Notion
                              </p>
                              <p className="m-0">
                                For each influencer discovered, add them to the
                                Notion database. Save the returned page IDs for
                                updating later with analysis.
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-medium text-[14px] leading-[20px]">
                                Phase 4: Analyze Each Influencer
                              </p>
                              <p className="m-0">
                                Evaluate their relevance based on followers
                                (&gt;5,000), content alignment, and profile
                                description. Classify as &quot;Highly
                                Relevant&quot; or &quot;Not Relevant&quot;.
                              </p>
                            </div>
                          )}

                        {selectedAgent === "tiktok" && activeTab === "yaml" && (
                          <div
                            className="text-[13px] leading-[18px] whitespace-pre-wrap break-words"
                            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                          >
                            <p className="m-0">
                              <span className="text-[#3b82f6]">version</span>
                              <span className="text-[#827d77]">:</span>{" "}
                              <span className="text-[#22c55e]">
                                &quot;1.0&quot;
                              </span>
                            </p>
                            <p className="m-0">&nbsp;</p>
                            <p className="m-0">
                              <span className="text-[#3b82f6]">agents</span>
                              <span className="text-[#827d77]">:</span>
                            </p>
                            <p className="m-0">
                              {"  "}
                              <span className="text-[#3b82f6]">
                                tiktok-influencer
                              </span>
                              <span className="text-[#827d77]">:</span>
                            </p>
                            <p className="m-0">
                              {"    "}
                              <span className="text-[#3b82f6]">
                                description
                              </span>
                              <span className="text-[#827d77]">:</span>{" "}
                              <span className="text-[#22c55e]">
                                &quot;TikTok influencer discovery and AI-powered
                                analysis agent with Notion integration&quot;
                              </span>
                            </p>
                            <p className="m-0">
                              {"    "}
                              <span className="text-[#3b82f6]">framework</span>
                              <span className="text-[#827d77]">:</span>{" "}
                              <span className="text-foreground">
                                claude-code
                              </span>
                            </p>
                            <p className="m-0">
                              {"    "}
                              <span className="text-[#3b82f6]">
                                instructions
                              </span>
                              <span className="text-[#827d77]">:</span>{" "}
                              <span className="text-foreground">AGENTS.md</span>
                            </p>
                            <p className="m-0">
                              {"    "}
                              <span className="text-[#3b82f6]">skills</span>
                              <span className="text-[#827d77]">:</span>
                            </p>
                            <p className="m-0">
                              {"      "}
                              <span className="text-[#827d77]">-</span>{" "}
                              <span className="text-[#06b6d4]">
                                https://github.com/vm0-ai/vm0-skills/tree/main/bright-data
                              </span>
                            </p>
                            <p className="m-0">
                              {"      "}
                              <span className="text-[#827d77]">-</span>{" "}
                              <span className="text-[#06b6d4]">
                                https://github.com/vm0-ai/vm0-skills/tree/main/notion
                              </span>
                            </p>
                            <p className="m-0">
                              {"    "}
                              <span className="text-[#3b82f6]">
                                environment
                              </span>
                              <span className="text-[#827d77]">:</span>
                            </p>
                            <p className="m-0">
                              {"      "}
                              <span className="text-[#3b82f6]">
                                BRIGHTDATA_API_KEY
                              </span>
                              <span className="text-[#827d77]">:</span>{" "}
                              <span className="text-foreground">$</span>
                              <span className="text-[#827d77]">
                                &#123;&#123;
                              </span>
                              <span className="text-foreground">
                                {" "}
                                secrets.BRIGHTDATA_API_KEY{" "}
                              </span>
                              <span className="text-[#827d77]">
                                &#125;&#125;
                              </span>
                            </p>
                            <p className="m-0">
                              {"      "}
                              <span className="text-[#3b82f6]">
                                NOTION_API_KEY
                              </span>
                              <span className="text-[#827d77]">:</span>{" "}
                              <span className="text-foreground">$</span>
                              <span className="text-[#827d77]">
                                &#123;&#123;
                              </span>
                              <span className="text-foreground">
                                {" "}
                                secrets.NOTION_API_KEY{" "}
                              </span>
                              <span className="text-[#827d77]">
                                &#125;&#125;
                              </span>
                            </p>
                          </div>
                        )}

                        {selectedAgent === "blog" && activeTab === "agents" && (
                          <div
                            className="text-[14px] leading-[20px]"
                            style={{ fontFamily: "var(--font-noto-sans)" }}
                          >
                            <p className="m-0 font-semibold text-[18px] leading-[26px]">
                              Content Farm Agent
                            </p>
                            <p className="m-0">&nbsp;</p>
                            <p className="m-0">
                              You are a professional content farm agent that
                              automatically generates high-quality,
                              SEO-optimized blog articles from trending news
                              sources.
                            </p>
                            <p className="m-0">&nbsp;</p>
                            <p className="m-0 font-semibold text-[15px] leading-[22px]">
                              Workflow
                            </p>
                            <p className="m-0">&nbsp;</p>
                            <p className="m-0 font-medium text-[14px] leading-[20px]">
                              Phase 1: Gather News
                            </p>
                            <p className="m-0">
                              Use the rss-fetch skill to collect recent articles
                              from major tech news sources.
                            </p>
                            <p className="m-0">&nbsp;</p>
                            <p className="m-0 font-medium text-[14px] leading-[20px]">
                              Phase 2: Filter and Select
                            </p>
                            <p className="m-0">
                              Review the fetched articles and select the most
                              relevant ones based on the user&apos;s specified
                              topic or keywords. Pick 3-5 articles.
                            </p>
                            <p className="m-0">&nbsp;</p>
                            <p className="m-0 font-medium text-[14px] leading-[20px]">
                              Phase 3: Create SEO Title
                            </p>
                            <p className="m-0">
                              Generate 5 long-tail SEO title candidates,
                              evaluate each for click-through potential, and
                              select the best one.
                            </p>
                            <p className="m-0">&nbsp;</p>
                            <p className="m-0 font-medium text-[14px] leading-[20px]">
                              Phase 4: Build Outline
                            </p>
                            <p className="m-0">
                              Create a structured outline with introduction, 2-3
                              main sections, conclusion, and references section.
                            </p>
                            <p className="m-0">&nbsp;</p>
                            <p className="m-0 font-medium text-[14px] leading-[20px]">
                              Phase 5: Write the Article
                            </p>
                            <p className="m-0">
                              Write a 1000-1500 word article with conversational
                              tone, short paragraphs, and natural keyword
                              integration.
                            </p>
                            <p className="m-0">&nbsp;</p>
                            <p className="m-0 font-medium text-[14px] leading-[20px]">
                              Phase 6-8: Generate Image, Prepare Output, Publish
                            </p>
                            <p className="m-0">
                              Create featured image, save to output folder, and
                              publish to Dev.to.
                            </p>
                          </div>
                        )}

                        {selectedAgent === "blog" && activeTab === "yaml" && (
                          <div
                            className="text-[13px] leading-[18px] whitespace-pre-wrap break-words"
                            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                          >
                            <p className="m-0">
                              <span className="text-[#3b82f6]">version</span>
                              <span className="text-[#827d77]">:</span>{" "}
                              <span className="text-[#22c55e]">
                                &quot;1.0&quot;
                              </span>
                            </p>
                            <p className="m-0">&nbsp;</p>
                            <p className="m-0">
                              <span className="text-[#3b82f6]">agents</span>
                              <span className="text-[#827d77]">:</span>
                            </p>
                            <p className="m-0">
                              {"  "}
                              <span className="text-[#3b82f6]">
                                content-farm
                              </span>
                              <span className="text-[#827d77]">:</span>
                            </p>
                            <p className="m-0">
                              {"    "}
                              <span className="text-[#3b82f6]">
                                description
                              </span>
                              <span className="text-[#827d77]">:</span>{" "}
                              <span className="text-[#22c55e]">
                                &quot;AI-powered blog content generation
                                agent&quot;
                              </span>
                            </p>
                            <p className="m-0">
                              {"    "}
                              <span className="text-[#3b82f6]">framework</span>
                              <span className="text-[#827d77]">:</span>{" "}
                              <span className="text-foreground">
                                claude-code
                              </span>
                            </p>
                            <p className="m-0">
                              {"    "}
                              <span className="text-[#3b82f6]">
                                instructions
                              </span>
                              <span className="text-[#827d77]">:</span>{" "}
                              <span className="text-foreground">AGENTS.md</span>
                            </p>
                            <p className="m-0">
                              {"    "}
                              <span className="text-[#3b82f6]">skills</span>
                              <span className="text-[#827d77]">:</span>
                            </p>
                            <p className="m-0">
                              {"      "}
                              <span className="text-[#827d77]">-</span>{" "}
                              <span className="text-[#06b6d4]">
                                https://github.com/vm0-ai/vm0-skills/tree/main/rss-fetch
                              </span>
                            </p>
                            <p className="m-0">
                              {"      "}
                              <span className="text-[#827d77]">-</span>{" "}
                              <span className="text-[#06b6d4]">
                                https://github.com/vm0-ai/vm0-skills/tree/main/fal.ai
                              </span>
                            </p>
                            <p className="m-0">
                              {"      "}
                              <span className="text-[#827d77]">-</span>{" "}
                              <span className="text-[#06b6d4]">
                                https://github.com/vm0-ai/vm0-skills/tree/main/dev.to
                              </span>
                            </p>
                            <p className="m-0">
                              {"    "}
                              <span className="text-[#3b82f6]">
                                environment
                              </span>
                              <span className="text-[#827d77]">:</span>
                            </p>
                            <p className="m-0">
                              {"      "}
                              <span className="text-[#3b82f6]">FAL_KEY</span>
                              <span className="text-[#827d77]">:</span>{" "}
                              <span className="text-foreground">$</span>
                              <span className="text-[#827d77]">
                                &#123;&#123;
                              </span>
                              <span className="text-foreground">
                                {" "}
                                secrets.FAL_KEY{" "}
                              </span>
                              <span className="text-[#827d77]">
                                &#125;&#125;
                              </span>
                            </p>
                            <p className="m-0">
                              {"      "}
                              <span className="text-[#3b82f6]">
                                DEVTO_API_KEY
                              </span>
                              <span className="text-[#827d77]">:</span>{" "}
                              <span className="text-foreground">$</span>
                              <span className="text-[#827d77]">
                                &#123;&#123;
                              </span>
                              <span className="text-foreground">
                                {" "}
                                secrets.DEVTO_API_KEY{" "}
                              </span>
                              <span className="text-[#827d77]">
                                &#125;&#125;
                              </span>
                            </p>
                          </div>
                        )}

                        {selectedAgent === "daily-report" &&
                          activeTab === "agents" && (
                            <div
                              className="text-[14px] leading-[20px]"
                              style={{ fontFamily: "var(--font-noto-sans)" }}
                            >
                              <p className="m-0 font-semibold text-[18px] leading-[26px]">
                                Daily Data Report Agent
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0">
                                This agent generates comprehensive daily reports
                                for the vm0 team across eight sequential phases.
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-semibold text-[15px] leading-[22px]">
                                Key Data Collection Areas
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-medium text-[14px] leading-[20px]">
                                GitHub Repository Metrics
                              </p>
                              <p className="m-0">
                                Stars, forks, watchers, and open issues for
                                vm0-ai/vm0
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-medium text-[14px] leading-[20px]">
                                Website Analytics
                              </p>
                              <p className="m-0">
                                Yesterday&apos;s visitor counts, pageviews,
                                bounce rates, visit duration, and traffic source
                                analysis
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-medium text-[14px] leading-[20px]">
                                User Statistics
                              </p>
                              <p className="m-0">
                                Total users, active users from yesterday, and
                                new user registrations
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-medium text-[14px] leading-[20px]">
                                Code Changes
                              </p>
                              <p className="m-0">
                                Commits, file modifications, and line
                                additions/removals with author attribution
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-medium text-[14px] leading-[20px]">
                                Document Activity
                              </p>
                              <p className="m-0">
                                Notion pages created and edited with change
                                attribution
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0 font-semibold text-[15px] leading-[22px]">
                                Output
                              </p>
                              <p className="m-0">
                                Reports are saved as markdown files and Slack
                                notification sent with key metrics.
                              </p>
                            </div>
                          )}

                        {selectedAgent === "daily-report" &&
                          activeTab === "yaml" && (
                            <div
                              className="text-[13px] leading-[18px] whitespace-pre-wrap break-words"
                              style={{
                                fontFamily: "var(--font-jetbrains-mono)",
                              }}
                            >
                              <p className="m-0">
                                <span className="text-[#3b82f6]">version</span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-[#22c55e]">
                                  &quot;1.0&quot;
                                </span>
                              </p>
                              <p className="m-0">&nbsp;</p>
                              <p className="m-0">
                                <span className="text-[#3b82f6]">agents</span>
                                <span className="text-[#827d77]">:</span>
                              </p>
                              <p className="m-0">
                                {"  "}
                                <span className="text-[#3b82f6]">
                                  daily-data-report
                                </span>
                                <span className="text-[#827d77]">:</span>
                              </p>
                              <p className="m-0">
                                {"    "}
                                <span className="text-[#3b82f6]">
                                  description
                                </span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-[#22c55e]">
                                  &quot;Daily data report agent that gathers
                                  GitHub stats, Plausible analytics, code
                                  changes, and Notion updates&quot;
                                </span>
                              </p>
                              <p className="m-0">
                                {"    "}
                                <span className="text-[#3b82f6]">
                                  framework
                                </span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-foreground">
                                  claude-code
                                </span>
                              </p>
                              <p className="m-0">
                                {"    "}
                                <span className="text-[#3b82f6]">
                                  instructions
                                </span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-foreground">
                                  AGENTS.md
                                </span>
                              </p>
                              <p className="m-0">
                                {"    "}
                                <span className="text-[#3b82f6]">skills</span>
                                <span className="text-[#827d77]">:</span>
                              </p>
                              <p className="m-0">
                                {"      "}
                                <span className="text-[#827d77]">-</span>{" "}
                                <span className="text-[#06b6d4]">
                                  https://github.com/vm0-ai/vm0-skills/tree/main/github
                                </span>
                              </p>
                              <p className="m-0">
                                {"      "}
                                <span className="text-[#827d77]">-</span>{" "}
                                <span className="text-[#06b6d4]">
                                  https://github.com/vm0-ai/vm0-skills/tree/main/plausible
                                </span>
                              </p>
                              <p className="m-0">
                                {"      "}
                                <span className="text-[#827d77]">-</span>{" "}
                                <span className="text-[#06b6d4]">
                                  https://github.com/vm0-ai/vm0-skills/tree/main/notion
                                </span>
                              </p>
                              <p className="m-0">
                                {"      "}
                                <span className="text-[#827d77]">-</span>{" "}
                                <span className="text-[#06b6d4]">
                                  https://github.com/vm0-ai/vm0-skills/tree/main/slack
                                </span>
                              </p>
                              <p className="m-0">
                                {"    "}
                                <span className="text-[#3b82f6]">
                                  environment
                                </span>
                                <span className="text-[#827d77]">:</span>
                              </p>
                              <p className="m-0">
                                {"      "}
                                <span className="text-[#3b82f6]">
                                  GITHUB_TOKEN
                                </span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-foreground">$</span>
                                <span className="text-[#827d77]">
                                  &#123;&#123;
                                </span>
                                <span className="text-foreground">
                                  {" "}
                                  secrets.GITHUB_TOKEN{" "}
                                </span>
                                <span className="text-[#827d77]">
                                  &#125;&#125;
                                </span>
                              </p>
                              <p className="m-0">
                                {"      "}
                                <span className="text-[#3b82f6]">
                                  PLAUSIBLE_API_KEY
                                </span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-foreground">$</span>
                                <span className="text-[#827d77]">
                                  &#123;&#123;
                                </span>
                                <span className="text-foreground">
                                  {" "}
                                  secrets.PLAUSIBLE_API_KEY{" "}
                                </span>
                                <span className="text-[#827d77]">
                                  &#125;&#125;
                                </span>
                              </p>
                              <p className="m-0">
                                {"      "}
                                <span className="text-[#3b82f6]">
                                  PLAUSIBLE_SITE_ID
                                </span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-foreground">$</span>
                                <span className="text-[#827d77]">
                                  &#123;&#123;
                                </span>
                                <span className="text-foreground">
                                  {" "}
                                  secrets.PLAUSIBLE_SITE_ID{" "}
                                </span>
                                <span className="text-[#827d77]">
                                  &#125;&#125;
                                </span>
                              </p>
                              <p className="m-0">
                                {"      "}
                                <span className="text-[#3b82f6]">
                                  NOTION_API_KEY
                                </span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-foreground">$</span>
                                <span className="text-[#827d77]">
                                  &#123;&#123;
                                </span>
                                <span className="text-foreground">
                                  {" "}
                                  secrets.NOTION_API_KEY{" "}
                                </span>
                                <span className="text-[#827d77]">
                                  &#125;&#125;
                                </span>
                              </p>
                              <p className="m-0">
                                {"      "}
                                <span className="text-[#3b82f6]">
                                  SLACK_BOT_TOKEN
                                </span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-foreground">$</span>
                                <span className="text-[#827d77]">
                                  &#123;&#123;
                                </span>
                                <span className="text-foreground">
                                  {" "}
                                  secrets.SLACK_BOT_TOKEN{" "}
                                </span>
                                <span className="text-[#827d77]">
                                  &#125;&#125;
                                </span>
                              </p>
                              <p className="m-0">
                                {"      "}
                                <span className="text-[#3b82f6]">
                                  SLACK_CHANNEL_ID
                                </span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-foreground">$</span>
                                <span className="text-[#827d77]">
                                  &#123;&#123;
                                </span>
                                <span className="text-foreground">
                                  {" "}
                                  secrets.SLACK_CHANNEL_ID{" "}
                                </span>
                                <span className="text-[#827d77]">
                                  &#125;&#125;
                                </span>
                              </p>
                              <p className="m-0">
                                {"      "}
                                <span className="text-[#3b82f6]">
                                  CLERK_SECRET_KEY
                                </span>
                                <span className="text-[#827d77]">:</span>{" "}
                                <span className="text-foreground">$</span>
                                <span className="text-[#827d77]">
                                  &#123;&#123;
                                </span>
                                <span className="text-foreground">
                                  {" "}
                                  secrets.CLERK_SECRET_KEY{" "}
                                </span>
                                <span className="text-[#827d77]">
                                  &#125;&#125;
                                </span>
                              </p>
                            </div>
                          )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Sample Agents */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-[12px] sm:gap-[16px] rounded-[8px] mb-[20px]">
                  <AgentCard
                    icon="/landing/ycombinator.svg"
                    title="HackerNews Agent"
                    description="Get Hacker News insights from personal digest."
                    onClick={() => setSelectedAgent("hackernews")}
                    isSelected={selectedAgent === "hackernews"}
                    variant="gradient-left"
                  />
                  <AgentCard
                    icon="/landing/screenshot.png"
                    title="TikTok Influencer Agent"
                    description="Search, filter, and surface TikTok creators for you."
                    onClick={() => setSelectedAgent("tiktok")}
                    isSelected={selectedAgent === "tiktok"}
                    variant="white"
                  />
                  <AgentCard
                    icon={{
                      light: "/landing/notion.svg",
                      dark: "/landing/notion-dark.svg",
                    }}
                    title="Daily report agent"
                    description="Aggregate data from multiple sources and APIs, then summarize in Notion."
                    onClick={() => setSelectedAgent("daily-report")}
                    isSelected={selectedAgent === "daily-report"}
                    variant="white"
                  />
                  <AgentCard
                    icon="/landing/fal-image.svg"
                    title="Blog generator"
                    description="Automate blog generation with multiple APIs."
                    onClick={() => setSelectedAgent("blog")}
                    isSelected={selectedAgent === "blog"}
                    variant="gradient-right"
                  />
                </div>

                <a
                  href="https://github.com/vm0-ai/vm0-cookbooks/tree/main/examples"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex gap-[8px] items-center justify-center hover:opacity-80 transition-opacity cursor-pointer"
                >
                  <p
                    className="text-[14px] leading-[20px] text-primary font-normal"
                    style={{ fontFamily: "var(--font-noto-sans)" }}
                  >
                    Show more sample agents
                  </p>
                  <div className="flex items-center justify-center w-[16px] h-[16px] -rotate-90">
                    <IconChevronDown size={16} className="text-primary" />
                  </div>
                </a>
              </div>
            )}

            {/* Build an agent */}
            {mainTab === "build" && (
              <div
                ref={buildSectionRef}
                className="flex flex-col gap-[30px] mb-20 px-4"
              >
                <div className="text-center">
                  <h2 className="text-[24px] sm:text-[30px] md:text-[36px] font-medium leading-[1.2] text-foreground mb-4">
                    Build an agent
                  </h2>
                  <p className="text-[14px] sm:text-[16px] leading-[1.5] text-foreground">
                    Build your agent with the VM0 builder skill and CLI.
                  </p>
                  <p className="text-[14px] sm:text-[16px] leading-[1.5] text-foreground">
                    Create agents in Claude Code using natural language, on a
                    secure and reliable infrastructure.
                  </p>
                </div>

                <div
                  className="rounded-[6px] pt-[20px] pb-[20px] sm:pb-[30px] px-[16px] sm:px-[30px] md:px-[100px] lg:px-[200px] xl:px-[300px]"
                  style={{
                    backgroundImage:
                      "linear-gradient(137.478deg, rgb(183, 200, 210) 0.82464%, rgb(253, 175, 83) 45.285%, rgb(248, 127, 48) 99.384%)",
                  }}
                >
                  <div className="bg-white dark:bg-[#19191b] border-[0.5px] border-border rounded-[12px] shadow-[0px_25px_50px_-12px_rgba(0,0,0,0.25)] overflow-hidden h-[422px]">
                    {/* Terminal Header */}
                    <div className="bg-[#f9f4ef] dark:bg-[#292a2e] p-[8px] flex gap-[76px] items-center shadow-[0px_0.5px_0px_0px_#d2d2d2] dark:shadow-[0px_0.5px_0px_0px_#2f2f32]">
                      <div className="flex gap-1.5">
                        <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                        <div className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
                        <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                      </div>
                      <p
                        className="text-[12px] text-center font-medium w-[354px]"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        <span className="text-[#827d77]">~/work</span>
                        <span className="text-foreground">
                          {" "}
                          * VM0 Agent ▸ Claude Code
                        </span>
                      </p>
                    </div>

                    {/* Terminal Content */}
                    <div
                      className="p-[20px] overflow-y-auto h-[calc(422px-41px)]"
                      style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                    >
                      <div className="flex gap-[10px] items-start text-[12px] leading-[16px]">
                        <div className="flex gap-[4px] items-center">
                          <div className="text-black dark:text-white">
                            <p className="m-0"> *</p>
                            <p className="m-0">*</p>
                            <p className="m-0"> *</p>
                          </div>
                          <Image
                            src="/landing/vector-logo.svg"
                            alt="VM0"
                            width="65"
                            height="40"
                          />
                          <div className="text-black dark:text-white">
                            <p className="m-0">*</p>
                            <p className="m-0"> *</p>
                            <p className="m-0">*</p>
                          </div>
                        </div>
                        <div className="text-[11px]">
                          <p className="m-0">
                            <span className="font-bold">Claude Code</span>{" "}
                            v2.0.76
                          </p>
                          <p className="m-0 text-[#827d77]">
                            Sonnet 4.5 · Claude API
                          </p>
                          <p className="m-0 text-[#827d77]">/Users/ming</p>
                        </div>
                      </div>

                      <div className="mt-[10px] text-[12px] leading-[16px] space-y-0 font-light">
                        {/* Step 0: Loading message */}
                        {buildAnimationStep >= 0 && (
                          <>
                            <p className="m-0 text-[#827d77]">
                              &gt; The &quot;vm0-agent&quot; skill is loading
                            </p>
                            <p className="m-0">&nbsp;</p>
                          </>
                        )}

                        {/* Step 1: User input with typewriter effect */}
                        {buildAnimationStep >= 1 && (
                          <p className="m-0">
                            <span className="text-[#f59e0b]">●</span>{" "}
                            <span className="text-black dark:text-white font-medium">
                              {typedText}
                            </span>
                            {buildAnimationStep === 1 && (
                              <span className="text-black dark:text-white animate-pulse">
                                {" "}
                                █
                              </span>
                            )}
                          </p>
                        )}

                        {buildAnimationStep >= 2 && (
                          <p className="m-0">&nbsp;</p>
                        )}

                        {/* Step 2: First agent response */}
                        {buildAnimationStep >= 2 && (
                          <>
                            <p className="m-0">
                              <span className="text-[#22c55e]">⏺</span>{" "}
                              <span className="text-secondary-foreground">
                                I&apos;ll help you build a VM0 workflow! Let me
                                understand what you want to automate.
                              </span>
                            </p>
                            <p className="m-0">&nbsp;</p>
                          </>
                        )}

                        {/* Step 3: User answers */}
                        {buildAnimationStep >= 3 && (
                          <>
                            <p className="m-0">
                              <span className="text-[#22c55e]">⏺</span>{" "}
                              <span className="text-secondary-foreground">
                                User answered Claude&apos;s questions:
                              </span>
                            </p>
                            <p className="m-0 text-[#827d77]">
                              {" "}
                              ⎿ · What to aggregate? → Tech news from RSS feeds
                            </p>
                            <p className="m-0 text-[#827d77]">
                              {" "}
                              · How to process? → Summarize top 5 articles
                            </p>
                            <p className="m-0 text-[#827d77]">
                              {" "}
                              · Where to send? → Slack #tech-news channel
                            </p>
                            <p className="m-0">&nbsp;</p>
                          </>
                        )}

                        {/* Step 4: Finding skills */}
                        {buildAnimationStep >= 4 && (
                          <>
                            <p className="m-0">
                              <span className="text-[#22c55e]">⏺</span>{" "}
                              <span className="text-secondary-foreground">
                                Perfect! Let me find the right skills for your
                                workflow.
                              </span>
                            </p>
                            <p className="m-0">&nbsp;</p>
                          </>
                        )}

                        {/* Step 5: Fetch skills */}
                        {buildAnimationStep >= 5 && (
                          <>
                            <p className="m-0">
                              <span className="text-[#22c55e]">⏺</span>{" "}
                              <span className="text-[#3b82f6]">Fetch</span>
                              <span className="text-secondary-foreground">
                                (
                              </span>
                              <span className="text-[#06b6d4]">
                                https://github.com/vm0-ai/vm0-skills
                              </span>
                              <span className="text-secondary-foreground">
                                )
                              </span>
                            </p>
                            <p className="m-0 text-[#827d77]">
                              {" "}
                              ⎿ Received 389KB (200 OK)
                            </p>
                            <p className="m-0">&nbsp;</p>
                          </>
                        )}

                        {/* Step 6: Write vm0.yaml */}
                        {buildAnimationStep >= 6 && (
                          <>
                            <p className="m-0">
                              <span className="text-[#22c55e]">⏺</span>{" "}
                              <span className="text-[#3b82f6]">Write</span>
                              <span className="text-secondary-foreground">
                                (
                              </span>
                              <span className="text-[#06b6d4]">vm0.yaml</span>
                              <span className="text-secondary-foreground">
                                )
                              </span>
                            </p>
                            <p className="m-0 text-[#827d77]">
                              {" "}
                              ⎿ Wrote 8 lines to vm0.yaml
                            </p>
                            <p className="m-0 text-[#6b7280]"> 1 agents:</p>
                            <p className="m-0 text-[#6b7280]">
                              {" "}
                              2 tech-news-digest:
                            </p>
                            <p className="m-0 text-[#6b7280]">
                              {" "}
                              3 framework: claude-code
                            </p>
                            <p className="m-0 text-[#6b7280]">
                              {" "}
                              4 instructions: AGENTS.md
                            </p>
                            <p className="m-0 text-[#6b7280]"> 5 skills:</p>
                            <p className="m-0 text-[#6b7280]">
                              {" "}
                              6 - vm0-skills/rss-fetch
                            </p>
                            <p className="m-0 text-[#6b7280]">
                              {" "}
                              7 - vm0-skills/slack
                            </p>
                            <p className="m-0 text-[#6b7280]"> … +1 line</p>
                            <p className="m-0">&nbsp;</p>
                          </>
                        )}

                        {/* Step 7: Write AGENTS.md */}
                        {buildAnimationStep >= 7 && (
                          <>
                            <p className="m-0">
                              <span className="text-[#22c55e]">⏺</span>{" "}
                              <span className="text-[#3b82f6]">Write</span>
                              <span className="text-secondary-foreground">
                                (
                              </span>
                              <span className="text-[#06b6d4]">AGENTS.md</span>
                              <span className="text-secondary-foreground">
                                )
                              </span>
                            </p>
                            <p className="m-0 text-[#827d77]">
                              {" "}
                              ⎿ Wrote 47 lines to AGENTS.md
                            </p>
                            <p className="m-0 text-[#6b7280]">
                              {" "}
                              1 # Tech News Daily Digest Agent
                            </p>
                            <p className="m-0 text-[#6b7280]">
                              {" "}
                              2 Fetch TechCrunch RSS, summarize top 5 articles
                            </p>
                            <p className="m-0 text-[#6b7280]">
                              {" "}
                              … +43 lines (ctrl+o to expand)
                            </p>
                            <p className="m-0">&nbsp;</p>
                          </>
                        )}

                        {/* Step 8: Final message */}
                        {buildAnimationStep >= 8 && (
                          <>
                            <p className="m-0">
                              <span className="text-[#22c55e]">⏺</span>{" "}
                              <span className="text-secondary-foreground">
                                Your agent is ready!
                              </span>
                            </p>
                            <p className="m-0">&nbsp;</p>
                            <p className="m-0">
                              <span className="text-[#22c55e]">⏺</span>{" "}
                              <span className="text-secondary-foreground">
                                Run now or schedule it:
                              </span>
                            </p>
                            <p className="m-0 text-[#827d77]">
                              {" "}
                              → Just say: &quot;fetch tech news&quot;
                            </p>
                            <p className="m-0 text-[#827d77]">
                              {" "}
                              → Or: &quot;run this daily at 9am&quot;
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Features Section */}
        <section className="w-full max-w-[1440px] px-4 sm:px-6 md:px-8 pb-10">
          <div className="max-w-[1200px] mx-auto">
            <h2
              className="text-[24px] sm:text-[30px] md:text-[36px] font-medium leading-[1.2] mb-8 sm:mb-12"
              style={{ fontFamily: "var(--font-noto-sans)" }}
            >
              Our features
            </h2>

            <div className="flex flex-col lg:flex-row gap-[12px] mb-0">
              {/* Feature 1: Natural language building */}
              <div className="flex-1 bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] overflow-hidden flex flex-col gap-[10px]">
                <div className="flex flex-col gap-[24px] flex-1">
                  <div className="flex flex-col gap-[16px] p-[16px] sm:p-[24px]">
                    <h3
                      className="text-[20px] sm:text-[24px] md:text-[30px] leading-[1.2]"
                      style={{ fontFamily: "var(--font-noto-sans)" }}
                    >
                      Natural language building
                    </h3>
                    <p
                      className="text-[14px] sm:text-[16px] leading-[1.5] text-foreground"
                      style={{ fontFamily: "var(--font-noto-sans)" }}
                    >
                      Describe your goals in Claude Code to co-edit AGENTS.md.
                      Pick the right skills, and you&apos;re all set.
                    </p>
                  </div>

                  {/* Code diff visualization */}
                  <div className="bg-[#f9f4ef] dark:bg-[#292a2e] flex-1 p-[24px]">
                    <div className="bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[12px] p-[10px] flex-1 flex flex-col justify-center items-center overflow-hidden">
                      <div className="flex-1 flex gap-[8px] items-start justify-center w-full min-h-px min-w-px">
                        <div className="h-[16px] w-[8px] shrink-0 relative">
                          <svg
                            width="8"
                            height="16"
                            viewBox="0 0 8 16"
                            fill="none"
                          >
                            <circle cx="4" cy="8" r="3" fill="#22c55e" />
                          </svg>
                        </div>

                        <div className="flex-1 flex flex-col gap-[8px] items-start min-h-px min-w-px">
                          <p
                            className="text-[12px] leading-normal w-full"
                            style={{ fontFamily: "var(--font-fira-mono)" }}
                          >
                            <span className="font-bold">Write</span>
                            <span>(AGENTS.md)</span>
                          </p>

                          <div className="flex items-center justify-center pl-[8px] w-full">
                            <p
                              className="flex-1 text-[12px] leading-normal min-h-px min-w-px"
                              style={{ fontFamily: "var(--font-fira-mono)" }}
                            >
                              <span>Added </span>
                              <span className="font-bold">40</span>
                              <span> lines</span>
                            </p>
                          </div>

                          <div className="flex items-center justify-center pl-[16px] w-full">
                            <div
                              className="flex-1 text-[12px] leading-normal min-h-px min-w-px"
                              style={{
                                fontFamily: "var(--font-jetbrains-mono)",
                              }}
                            >
                              <p className="mb-px bg-[#fee2e2] dark:bg-[#4c1d1d]">
                                1 - # Agent Instructions
                              </p>
                              <p className="mb-px bg-[#dcfce7] dark:bg-[#1d4c1d]">
                                1 + # Design Scout Agent Instructions
                              </p>
                              <p className="mb-px">2</p>
                              <p className="mb-px bg-[#dcfce7] dark:bg-[#1d4c1d]">{`3 + Your role is to help the team stay `}</p>
                              <p className="mb-px bg-[#dcfce7] dark:bg-[#1d4c1d]">{`4 + aware of emerging patterns, `}</p>
                              <p className="mb-px bg-[#dcfce7] dark:bg-[#1d4c1d]">{`5 + references, and ideas across product `}</p>
                              <p className="mb-px bg-[#dcfce7] dark:bg-[#1d4c1d]">{`6 + design, UI/UX, and developer `}</p>
                              <p className="mb-px bg-[#dcfce7] dark:bg-[#1d4c1d]">{`7 + experience, without requiring manual `}</p>
                              <p className="mb-px bg-[#dcfce7] dark:bg-[#1d4c1d]">
                                8 + tracking.
                              </p>
                              <p className="mb-px bg-[#dcfce7] dark:bg-[#1d4c1d]">
                                9 + ## Workflow
                              </p>
                              <p className="mb-px bg-[#dcfce7] dark:bg-[#1d4c1d]">
                                10+ Phase 1
                              </p>
                              <p className="mb-px bg-[#dcfce7] dark:bg-[#1d4c1d]">
                                11+ Signal Collection
                              </p>
                              <p className="mb-px bg-[#dcfce7] dark:bg-[#1d4c1d]">{`12+ In this phase, the agent focuses on 13+ broad signal gathering.Identify `}</p>
                              <p className="bg-[#dcfce7] dark:bg-[#1d4c1d]">
                                14+ recurring themes and notable changes
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Feature 2: Cloud sandbox continuously */}
              <div className="flex-1 bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] overflow-hidden flex flex-col gap-[10px]">
                <div className="flex flex-col gap-[24px] flex-1 min-h-px min-w-px">
                  <div className="flex flex-col gap-[16px] p-[16px] sm:p-[24px]">
                    <h3
                      className="text-[20px] sm:text-[24px] md:text-[30px] leading-[1.2]"
                      style={{ fontFamily: "var(--font-noto-sans)" }}
                    >
                      Cloud sandbox continuously
                    </h3>
                    <div className="flex flex-col">
                      <p
                        className="text-[14px] sm:text-[16px] leading-[1.5] text-foreground mb-0"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        Cook locally, run in the cloud. Convert your local skill
                        to cloud 24/7.
                      </p>
                      <p
                        className="text-[14px] sm:text-[16px]"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        &nbsp;
                      </p>
                    </div>
                  </div>

                  {/* Command flow visualization */}
                  <div className="bg-[#f9f4ef] dark:bg-[#292a2e] flex-1 min-h-px min-w-px p-[24px]">
                    <div className="flex flex-col justify-between items-center h-full w-full">
                      <div className="bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] px-[10px] py-[8px] w-full flex-1 flex items-center justify-center">
                        <div className="flex gap-[10px] items-center justify-center">
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="shrink-0"
                          >
                            <path d="M7 4v16l13 -8z" />
                          </svg>
                          <h3
                            className="text-[16px] font-medium leading-[1.2]"
                            style={{ fontFamily: "var(--font-noto-sans)" }}
                          >
                            vm0 run [prompt]
                          </h3>
                        </div>
                      </div>

                      <div className="flex h-[30px] items-center justify-end flex-col">
                        <div className="w-[1px] flex-1 bg-[#d9d3cd]"></div>
                        <svg
                          width="10"
                          height="6"
                          viewBox="0 0 10 6"
                          fill="none"
                          className="shrink-0"
                        >
                          <path d="M5 6L0 0L10 0L5 6Z" fill="#d9d3cd" />
                        </svg>
                      </div>

                      <div className="bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] px-[10px] py-[8px] w-full flex-1 flex items-center justify-center">
                        <div className="flex gap-[10px] items-center justify-center">
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="shrink-0"
                          >
                            <circle cx="12" cy="12" r="9" />
                            <polyline points="12 7 12 12 15 15" />
                          </svg>
                          <h3
                            className="text-[16px] font-medium leading-[1.2]"
                            style={{ fontFamily: "var(--font-noto-sans)" }}
                          >
                            Schedule
                          </h3>
                        </div>
                      </div>

                      <div className="flex h-[30px] items-center justify-end flex-col">
                        <div className="w-[1px] flex-1 bg-[#d9d3cd]"></div>
                        <svg
                          width="10"
                          height="6"
                          viewBox="0 0 10 6"
                          fill="none"
                          className="shrink-0"
                        >
                          <path d="M5 6L0 0L10 0L5 6Z" fill="#d9d3cd" />
                        </svg>
                      </div>

                      <div className="bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] px-[10px] py-[8px] w-full flex-1 flex items-center justify-center">
                        <div className="flex gap-[10px] items-center justify-center">
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="shrink-0"
                          >
                            <path d="M12 3l8 4.5v9l-8 4.5l-8 -4.5v-9l8 -4.5" />
                            <path d="M12 12l8 -4.5" />
                            <path d="M12 12v9" />
                            <path d="M12 12l-8 -4.5" />
                          </svg>
                          <div className="flex flex-col text-center">
                            <h3
                              className="text-[16px] font-medium leading-[1.2]"
                              style={{ fontFamily: "var(--font-noto-sans)" }}
                            >
                              Executes in
                            </h3>
                            <h3
                              className="text-[16px] font-medium leading-[1.2]"
                              style={{ fontFamily: "var(--font-noto-sans)" }}
                            >
                              isolated sandbox
                            </h3>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Feature 3: Full agent observability */}
              <div className="flex-1 bg-white dark:bg-[#19191b] border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] overflow-hidden flex flex-col gap-[10px]">
                <div className="flex flex-col gap-[24px] flex-1">
                  <div className="flex flex-col gap-[16px] p-[16px] sm:p-[24px]">
                    <div className="flex flex-col">
                      <h3
                        className="block mb-0 text-[20px] sm:text-[24px] md:text-[30px] leading-[36px]"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        Full agent
                      </h3>
                      <h3
                        className="text-[20px] sm:text-[24px] md:text-[30px] leading-[36px]"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        <span className="leading-[36px]">o</span>
                        <span className="leading-[36px]">bservability</span>
                      </h3>
                    </div>
                    <div className="flex flex-col">
                      <p
                        className="text-[14px] sm:text-[16px] leading-[24px] text-foreground mb-0"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        See every execution detail.Real-time logs, artifact
                        outputs, and checkpoint replay.
                      </p>
                      <p
                        className="text-[16px]"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        &nbsp;
                      </p>
                    </div>
                  </div>

                  {/* Execution logs visualization */}
                  <div className="bg-[#f9f4ef] dark:bg-[#292a2e] flex-1 p-[24px]">
                    <div className="flex flex-col gap-[16px] items-start w-full">
                      {/* Initialize log */}
                      <div className="bg-white dark:bg-[#19191b] border border-[#f5eae1] dark:border-[#2f2f32] rounded-[8px] p-[16px] flex items-start justify-center overflow-hidden w-full">
                        <div className="flex-1 flex flex-col gap-[8px] items-start min-h-px min-w-px">
                          <div className="flex items-center justify-between w-full">
                            <div className="flex items-center">
                              <p
                                className="font-medium text-[14px] leading-[20px]"
                                style={{ fontFamily: "var(--font-noto-sans)" }}
                              >
                                Initialize
                              </p>
                            </div>
                            <div className="flex items-center justify-center">
                              <p
                                className="text-[14px] leading-[20px] text-[#827d77]"
                                style={{ fontFamily: "var(--font-noto-sans)" }}
                              >
                                14:26:02
                              </p>
                            </div>
                          </div>
                          <div className="flex items-start w-full">
                            <div className="flex gap-[8px] items-start">
                              <div className="bg-[#fffcf9] dark:bg-[#19191b] border border-[#e1dbd5] dark:border-[#2f2f32] h-[22px] flex gap-[4px] items-center justify-center px-[6px] py-[2px] rounded-[8px]">
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 12 12"
                                  fill="none"
                                  className="shrink-0"
                                >
                                  <circle
                                    cx="6"
                                    cy="6"
                                    r="5.25"
                                    stroke="#22c55e"
                                    strokeWidth="1.5"
                                    fill="none"
                                  />
                                  <path
                                    d="M3.5 6L5 7.5L8.5 4"
                                    stroke="#22c55e"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    fill="none"
                                  />
                                </svg>
                                <p
                                  className="font-medium leading-[16px] text-[#827d77] text-[12px]"
                                  style={{
                                    fontFamily: "var(--font-noto-sans)",
                                  }}
                                >
                                  18 tools
                                </p>
                              </div>
                              <div className="bg-[#fffcf9] dark:bg-[#19191b] border border-[#e1dbd5] dark:border-[#2f2f32] h-[22px] flex gap-[4px] items-center justify-center px-[6px] py-[2px] rounded-[8px]">
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 12 12"
                                  fill="none"
                                  className="shrink-0"
                                >
                                  <circle
                                    cx="6"
                                    cy="6"
                                    r="5.25"
                                    stroke="#22c55e"
                                    strokeWidth="1.5"
                                    fill="none"
                                  />
                                  <path
                                    d="M3.5 6L5 7.5L8.5 4"
                                    stroke="#22c55e"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    fill="none"
                                  />
                                </svg>
                                <p
                                  className="font-medium leading-[16px] text-[#827d77] text-[12px]"
                                  style={{
                                    fontFamily: "var(--font-noto-sans)",
                                  }}
                                >
                                  10 commands
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Search TikTok log */}
                      <div className="bg-white dark:bg-[#19191b] border border-[#f5eae1] dark:border-[#2f2f32] rounded-[8px] p-[16px] flex items-start justify-center overflow-hidden w-full">
                        <div className="flex-1 flex flex-col gap-[8px] items-start min-h-px min-w-px">
                          <div className="flex gap-[10px] items-center justify-center w-full">
                            <p
                              className="flex-1 font-medium text-[14px] leading-[20px] min-h-px min-w-px"
                              style={{ fontFamily: "var(--font-noto-sans)" }}
                            >
                              Search TikTok for fitness influencers
                            </p>
                            <div className="flex items-center justify-center">
                              <p
                                className="text-[14px] leading-[20px] text-[#827d77]"
                                style={{ fontFamily: "var(--font-noto-sans)" }}
                              >
                                14:26:02
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-[8px] items-center w-full">
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 18 18"
                              fill="none"
                              className="shrink-0"
                            >
                              <circle
                                cx="9"
                                cy="9"
                                r="6.75"
                                stroke="#22c55e"
                                strokeWidth="1.5"
                                fill="none"
                              />
                              <path
                                d="M6 9L8 11L12 7"
                                stroke="#22c55e"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                fill="none"
                              />
                            </svg>
                            <p
                              className="text-[14px] leading-[20px] overflow-hidden text-ellipsis"
                              style={{ fontFamily: "var(--font-noto-sans)" }}
                            >
                              Search fitness creators on TikTok
                            </p>
                          </div>
                          <div className="flex gap-[8px] items-center w-full">
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="#eab308"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="shrink-0"
                            >
                              <path d="M10 20.777a8.942 8.942 0 0 1 -2.48 -.969" />
                              <path d="M14 3.223a9.003 9.003 0 0 1 0 17.554" />
                              <path d="M4.579 17.093a8.961 8.961 0 0 1 -1.227 -2.592" />
                              <path d="M3.124 10.5c.16 -.95 .468 -1.85 .9 -2.675l.169 -.305" />
                              <path d="M6.907 4.579a8.954 8.954 0 0 1 3.093 -1.356" />
                            </svg>
                            <p
                              className="flex-1 text-[14px] leading-[20px] min-h-px min-w-px"
                              style={{ fontFamily: "var(--font-noto-sans)" }}
                            >
                              Analyzing engagement metrics
                            </p>
                          </div>
                          <div className="flex gap-[8px] items-center w-full">
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 18 18"
                              fill="none"
                              className="shrink-0"
                            >
                              <circle
                                cx="9"
                                cy="9"
                                r="6.75"
                                stroke="#8c8782"
                                strokeWidth="1.5"
                                strokeDasharray="2 2"
                                fill="none"
                              />
                            </svg>
                            <p
                              className="flex-1 text-[14px] leading-[20px] overflow-hidden text-ellipsis min-h-px min-w-px"
                              style={{ fontFamily: "var(--font-noto-sans)" }}
                            >
                              Generate influencer report
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Let me prepare the request log */}
                      <div className="bg-white dark:bg-[#19191b] border border-[#f5eae1] dark:border-[#2f2f32] rounded-[8px] p-[16px] flex items-start justify-center overflow-hidden w-full">
                        <div className="flex-1 flex flex-col gap-[8px] items-start min-h-px min-w-px">
                          <div className="flex gap-[10px] items-center justify-center w-full">
                            <p
                              className="flex-1 font-medium text-[14px] leading-[20px] min-h-px min-w-px"
                              style={{ fontFamily: "var(--font-noto-sans)" }}
                            >
                              Let me prepare the request
                            </p>
                            <div className="flex items-center justify-center">
                              <p
                                className="text-[14px] leading-[20px] text-[#827d77]"
                                style={{ fontFamily: "var(--font-noto-sans)" }}
                              >
                                14:26:02
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-[8px] items-center w-full">
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 18 18"
                              fill="none"
                              className="shrink-0"
                            >
                              <path
                                d="M10.5 2.25H5.25C4.42 2.25 3.75 2.92 3.75 3.75V14.25C3.75 15.08 4.42 15.75 5.25 15.75H12.75C13.58 15.75 14.25 15.08 14.25 14.25V6L10.5 2.25Z"
                                stroke="#827d77"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                fill="none"
                              />
                              <path
                                d="M10.5 2.25V6H14.25"
                                stroke="#827d77"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                fill="none"
                              />
                            </svg>
                            <p
                              className="text-[14px] leading-[20px] overflow-hidden text-ellipsis"
                              style={{ fontFamily: "var(--font-noto-sans)" }}
                            >
                              Write
                            </p>
                            <p
                              className="text-[14px] leading-[20px] overflow-hidden text-ellipsis text-[#827d77]"
                              style={{ fontFamily: "var(--font-noto-sans)" }}
                            >
                              /temp/brightdata_request.json
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Comparison Section */}
        <section className="w-full max-w-[1440px] px-4 sm:px-6 md:px-8 py-10">
          <div className="max-w-[1200px] mx-auto flex flex-col gap-[30px] sm:gap-[40px]">
            <h2
              className="text-[24px] sm:text-[30px] md:text-[36px] font-medium leading-[1.2]"
              style={{ fontFamily: "var(--font-noto-sans)" }}
            >
              Flexible workflows. Lightweight frameworks. Full observability.
            </h2>

            <div
              className="flex flex-col gap-[10px] p-[16px] sm:p-[24px] md:p-[30px] rounded-[6px]"
              style={{
                backgroundImage:
                  "linear-gradient(109.494deg, rgb(255, 182, 63) 1.9286%, rgb(129, 176, 203) 102.67%)",
              }}
            >
              {/* Row 1: n8n & Dify vs VM0 */}
              <div className="flex flex-col md:flex-row md:relative gap-[10px] md:gap-0 md:h-[114px] w-full">
                <div
                  className="md:absolute md:left-0 md:top-0 w-full md:w-[536px] md:h-[114px]"
                  style={{
                    boxShadow:
                      "0px 20px 25px 0px rgba(0,0,0,0.1), 0px 8px 10px 0px rgba(0,0,0,0.1)",
                  }}
                >
                  <div className="bg-white rounded-[12px] p-[16px] sm:p-[24px] flex flex-col gap-[12px] items-center justify-center h-full overflow-hidden">
                    <div className="flex gap-[8px] items-center justify-center flex-wrap">
                      <Image
                        src="/landing/n8n-logo.svg"
                        alt="n8n"
                        width="111"
                        height="30"
                        className="dark:hidden"
                      />
                      <Image
                        src="/landing/n8n-logo-dark.svg"
                        alt="n8n"
                        width="111"
                        height="30"
                        className="hidden dark:block"
                      />
                      <p
                        className="text-[16px] leading-[24px] text-[#827d77]"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        &
                      </p>
                      <Image
                        src="/landing/dify-logo.svg"
                        alt="Dify"
                        width="67"
                        height="30"
                        className="dark:hidden"
                      />
                      <Image
                        src="/landing/dify-logo-dark.svg"
                        alt="Dify"
                        width="67"
                        height="30"
                        className="hidden dark:block"
                      />
                    </div>
                    <p
                      className="text-[14px] sm:text-[16px] leading-[1.5] text-center"
                      style={{ fontFamily: "var(--font-noto-sans)" }}
                    >
                      Drag nodes with preset paths
                    </p>
                  </div>
                </div>
                <div
                  className="md:absolute md:left-[604px] md:top-0 w-full md:w-[536px] md:h-[114px]"
                  style={{
                    boxShadow:
                      "0px 20px 25px 0px rgba(0,0,0,0.1), 0px 8px 10px 0px rgba(0,0,0,0.1)",
                  }}
                >
                  <div className="bg-white rounded-[12px] p-[16px] sm:p-[24px] flex flex-col gap-[12px] items-center justify-center h-full overflow-hidden">
                    <Image
                      src="/landing/logo.svg"
                      alt="VM0"
                      width="99"
                      height="30"
                      className="dark:hidden"
                    />
                    <Image
                      src="/landing/logo-dark.svg"
                      alt="VM0"
                      width="99"
                      height="30"
                      className="hidden dark:block"
                    />
                    <p
                      className="text-[14px] sm:text-[16px] leading-[1.5] text-center"
                      style={{ fontFamily: "var(--font-noto-sans)" }}
                    >
                      Natural language + Agent reasoning
                    </p>
                  </div>
                </div>
                <div className="hidden md:block md:absolute md:left-[654px] md:top-[52px] w-[10px] h-[10px]">
                  <div className="w-full h-full rounded-full bg-[#ed4e01]" />
                </div>
                <div className="hidden md:block md:absolute md:left-[416px] md:top-[56.88px] w-[243px] h-[1px]">
                  <svg
                    width="243"
                    height="1"
                    viewBox="0 0 243 1"
                    fill="none"
                    preserveAspectRatio="none"
                  >
                    <defs>
                      <linearGradient
                        id="gradient-row1"
                        x1="0"
                        y1="0"
                        x2="243"
                        y2="0"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop offset="0%" stopColor="#ed4e01" stopOpacity="0" />
                        <stop
                          offset="100%"
                          stopColor="#ed4e01"
                          stopOpacity="1"
                        />
                      </linearGradient>
                    </defs>
                    <rect
                      x="0"
                      y="0"
                      width="243"
                      height="1"
                      fill="url(#gradient-row1)"
                    />
                  </svg>
                </div>
              </div>

              {/* Row 2: E2B vs VM0 */}
              <div className="flex flex-col md:flex-row md:relative gap-[10px] md:gap-0 md:h-[114px] w-full">
                <div
                  className="md:absolute md:left-0 md:top-0 w-full md:w-[536px] md:h-[114px]"
                  style={{
                    boxShadow:
                      "0px 20px 25px 0px rgba(0,0,0,0.1), 0px 8px 10px 0px rgba(0,0,0,0.1)",
                  }}
                >
                  <div className="bg-white rounded-[12px] p-[16px] sm:p-[24px] flex flex-col gap-[12px] items-center justify-center h-full overflow-hidden">
                    <Image
                      src="/landing/e2b-logo.svg"
                      alt="E2B"
                      width="87"
                      height="30"
                      className="dark:hidden"
                    />
                    <Image
                      src="/landing/e2b-logo-dark.svg"
                      alt="E2B"
                      width="87"
                      height="30"
                      className="hidden dark:block"
                    />
                    <p
                      className="text-[14px] sm:text-[16px] leading-[1.5] text-center"
                      style={{ fontFamily: "var(--font-noto-sans)" }}
                    >
                      Generic infra needing config
                    </p>
                  </div>
                </div>
                <div
                  className="md:absolute md:left-[604px] md:top-0 w-full md:w-[536px] md:h-[114px]"
                  style={{
                    boxShadow:
                      "0px 20px 25px 0px rgba(0,0,0,0.1), 0px 8px 10px 0px rgba(0,0,0,0.1)",
                  }}
                >
                  <div className="bg-white rounded-[12px] p-[16px] sm:p-[24px] flex flex-col gap-[12px] items-center justify-center h-full overflow-hidden">
                    <Image
                      src="/landing/logo.svg"
                      alt="VM0"
                      width="99"
                      height="30"
                      className="dark:hidden"
                    />
                    <Image
                      src="/landing/logo-dark.svg"
                      alt="VM0"
                      width="99"
                      height="30"
                      className="hidden dark:block"
                    />
                    <p
                      className="text-[14px] sm:text-[16px] leading-[1.5] text-center"
                      style={{ fontFamily: "var(--font-noto-sans)" }}
                    >
                      Purpose-built for agents, minimal config
                    </p>
                  </div>
                </div>
                <div className="hidden md:block md:absolute md:left-[654px] md:top-[52px] w-[10px] h-[10px]">
                  <div className="w-full h-full rounded-full bg-[#ed4e01]" />
                </div>
                <div className="hidden md:block md:absolute md:left-[416px] md:top-[56.88px] w-[243px] h-[1px]">
                  <svg
                    width="243"
                    height="1"
                    viewBox="0 0 243 1"
                    fill="none"
                    preserveAspectRatio="none"
                  >
                    <defs>
                      <linearGradient
                        id="gradient-row2"
                        x1="0"
                        y1="0"
                        x2="243"
                        y2="0"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop offset="0%" stopColor="#ed4e01" stopOpacity="0" />
                        <stop
                          offset="100%"
                          stopColor="#ed4e01"
                          stopOpacity="1"
                        />
                      </linearGradient>
                    </defs>
                    <rect
                      x="0"
                      y="0"
                      width="243"
                      height="1"
                      fill="url(#gradient-row2)"
                    />
                  </svg>
                </div>
              </div>

              {/* Row 3: LangGraph vs VM0 */}
              <div className="flex flex-col md:flex-row md:relative gap-[10px] md:gap-0 md:h-[114px] w-full">
                <div
                  className="md:absolute md:left-0 md:top-0 w-full md:w-[536px] md:h-[114px]"
                  style={{
                    boxShadow:
                      "0px 20px 25px 0px rgba(0,0,0,0.1), 0px 8px 10px 0px rgba(0,0,0,0.1)",
                  }}
                >
                  <div className="bg-white rounded-[12px] p-[16px] sm:p-[24px] flex flex-col gap-[12px] items-center justify-center h-full overflow-hidden">
                    <Image
                      src="/landing/langgraph-logo.svg"
                      alt="LangGraph"
                      width="167"
                      height="30"
                      className="dark:hidden"
                    />
                    <Image
                      src="/landing/langgraph-logo-dark.svg"
                      alt="LangGraph"
                      width="167"
                      height="30"
                      className="hidden dark:block"
                    />
                    <p
                      className="text-[14px] sm:text-[16px] leading-[1.5] text-center"
                      style={{ fontFamily: "var(--font-noto-sans)" }}
                    >
                      Write code + Self-deploy
                    </p>
                  </div>
                </div>
                <div
                  className="md:absolute md:left-[604px] md:top-0 w-full md:w-[536px] md:h-[114px]"
                  style={{
                    boxShadow:
                      "0px 20px 25px 0px rgba(0,0,0,0.1), 0px 8px 10px 0px rgba(0,0,0,0.1)",
                  }}
                >
                  <div className="bg-white rounded-[12px] p-[16px] sm:p-[24px] flex flex-col gap-[12px] items-center justify-center h-full overflow-hidden">
                    <Image
                      src="/landing/logo.svg"
                      alt="VM0"
                      width="99"
                      height="30"
                      className="dark:hidden"
                    />
                    <Image
                      src="/landing/logo-dark.svg"
                      alt="VM0"
                      width="99"
                      height="30"
                      className="hidden dark:block"
                    />
                    <p
                      className="text-[14px] sm:text-[16px] leading-[1.5] text-center"
                      style={{ fontFamily: "var(--font-noto-sans)" }}
                    >
                      Zero code, one-click execution
                    </p>
                  </div>
                </div>
                <div className="hidden md:block md:absolute md:left-[654px] md:top-[52px] w-[10px] h-[10px]">
                  <div className="w-full h-full rounded-full bg-[#ed4e01]" />
                </div>
                <div className="hidden md:block md:absolute md:left-[416px] md:top-[56.88px] w-[243px] h-[1px]">
                  <svg
                    width="243"
                    height="1"
                    viewBox="0 0 243 1"
                    fill="none"
                    preserveAspectRatio="none"
                  >
                    <defs>
                      <linearGradient
                        id="gradient-row3"
                        x1="0"
                        y1="0"
                        x2="243"
                        y2="0"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop offset="0%" stopColor="#ed4e01" stopOpacity="0" />
                        <stop
                          offset="100%"
                          stopColor="#ed4e01"
                          stopOpacity="1"
                        />
                      </linearGradient>
                    </defs>
                    <rect
                      x="0"
                      y="0"
                      width="243"
                      height="1"
                      fill="url(#gradient-row3)"
                    />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Built For Section */}
        <section className="w-full max-w-[1440px] px-4 sm:px-6 md:px-8 py-10">
          <div className="max-w-[1200px] mx-auto flex flex-col gap-[30px] sm:gap-[40px]">
            <h2
              className="text-[24px] sm:text-[30px] md:text-[36px] font-medium leading-[1.2]"
              style={{ fontFamily: "var(--font-noto-sans)" }}
            >
              Built for
            </h2>

            <div className="flex flex-col lg:flex-row gap-[12px] w-full">
              {/* Left Card - Developers */}
              <div className="flex-1 bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] flex flex-col gap-[24px] overflow-hidden min-h-px min-w-px">
                <div className="flex flex-col gap-[10px] h-[232px] p-[24px]">
                  <div className="bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] flex-1 flex items-center px-[24px] py-[8px] min-h-px min-w-px opacity-60">
                    <div className="flex-1 flex gap-[24px] items-center min-h-px min-w-px">
                      <Image
                        src="/landing/check-icon.svg"
                        alt=""
                        width="20"
                        height="20"
                        className="shrink-0"
                      />
                      <p
                        className="text-[16px] leading-[24px]"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        Agentic product: Intelligent customer service systems
                      </p>
                    </div>
                  </div>
                  <div
                    className="bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] flex-1 flex items-center px-[24px] py-[8px] min-h-px min-w-px"
                    style={{
                      boxShadow:
                        "0px 10px 15px 0px rgba(0,0,0,0.1), 0px 4px 6px 0px rgba(0,0,0,0.1)",
                    }}
                  >
                    <div className="flex-1 flex gap-[24px] items-center min-h-px min-w-px">
                      <Image
                        src="/landing/check-icon.svg"
                        alt=""
                        width="20"
                        height="20"
                        className="shrink-0"
                      />
                      <p
                        className="text-[16px] leading-[24px]"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        Agentic product: Automation SaaS platforms
                      </p>
                    </div>
                  </div>
                  <div className="bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] flex-1 flex items-center px-[24px] py-[8px] min-h-px min-w-px opacity-30">
                    <div className="flex-1 flex gap-[24px] items-center min-h-px min-w-px">
                      <Image
                        src="/landing/check-icon.svg"
                        alt=""
                        width="20"
                        height="20"
                        className="shrink-0"
                      />
                      <p
                        className="text-[16px] leading-[24px]"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        Agentic product: Data analysis tools
                      </p>
                    </div>
                  </div>
                </div>
                <div className="bg-[#f9f4ef] dark:bg-[#292a2e] p-[24px] flex flex-col gap-[16px]">
                  <h3
                    className="text-[30px] leading-[36px]"
                    style={{ fontFamily: "var(--font-noto-sans)" }}
                  >
                    Developers and vibe coders building agent products
                  </h3>
                  <p
                    className="text-[16px] leading-[24px]"
                    style={{ fontFamily: "var(--font-noto-sans)" }}
                  >
                    Use VM0 as your product&apos;s underlying runtime and
                    evironment.
                  </p>
                </div>
              </div>

              {/* Right Card - Teams */}
              <div className="flex-1 bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] flex flex-col gap-[24px] overflow-hidden min-h-px min-w-px">
                <div className="flex flex-col gap-[10px] h-[232px] p-[24px]">
                  <div className="bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] flex-1 flex items-center px-[24px] py-[8px] min-h-px min-w-px opacity-60">
                    <div className="flex-1 flex gap-[24px] items-center min-h-px min-w-px">
                      <Image
                        src="/landing/check-icon.svg"
                        alt=""
                        width="20"
                        height="20"
                        className="shrink-0"
                      />
                      <p
                        className="text-[16px] leading-[24px]"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        Workflow: Social media auto-publishing
                      </p>
                    </div>
                  </div>
                  <div
                    className="bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] flex-1 flex items-center px-[24px] py-[8px] min-h-px min-w-px"
                    style={{
                      boxShadow:
                        "0px 10px 15px 0px rgba(0,0,0,0.1), 0px 4px 6px 0px rgba(0,0,0,0.1)",
                    }}
                  >
                    <div className="flex-1 flex gap-[24px] items-center min-h-px min-w-px">
                      <Image
                        src="/landing/check-icon.svg"
                        alt=""
                        width="20"
                        height="20"
                        className="shrink-0"
                      />
                      <p
                        className="text-[16px] leading-[24px]"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        Workflow: Cross-tool data synchronization
                      </p>
                    </div>
                  </div>
                  <div className="bg-white border border-[#f5eae1] dark:border-[#2f2f32] rounded-[10px] flex-1 flex items-center px-[24px] py-[8px] min-h-px min-w-px opacity-30">
                    <div className="flex-1 flex gap-[24px] items-center min-h-px min-w-px">
                      <Image
                        src="/landing/check-icon.svg"
                        alt=""
                        width="20"
                        height="20"
                        className="shrink-0"
                      />
                      <p
                        className="text-[16px] leading-[24px]"
                        style={{ fontFamily: "var(--font-noto-sans)" }}
                      >
                        Workflow: Outbound enrichment &amp; lead generation
                      </p>
                    </div>
                  </div>
                </div>
                <div className="bg-[#f9f4ef] dark:bg-[#292a2e] p-[24px] flex flex-col gap-[16px]">
                  <h3
                    className="text-[30px] leading-[36px]"
                    style={{ fontFamily: "var(--font-noto-sans)" }}
                  >
                    Teams and individuals needing automated workflows
                  </h3>
                  <p
                    className="text-[16px] leading-[24px]"
                    style={{ fontFamily: "var(--font-noto-sans)" }}
                  >
                    Save dozens of hours/month, runs 24/7.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="w-full max-w-[1440px] px-4 sm:px-6 md:px-8 py-10">
          <div className="max-w-[1200px] mx-auto bg-white dark:bg-[#19191b] border border-[#f5eae1] dark:border-[#2f2f32] rounded-[12px] p-[24px] sm:p-[40px] md:p-[60px] relative overflow-hidden flex flex-col gap-[24px] sm:gap-[30px]">
            {/* Decorative circular gradient background */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[1627px] h-[1627px] pointer-events-none">
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[1400px] h-[1400px] rotate-[79.76deg]">
                <div
                  className="w-full h-full rounded-full opacity-40"
                  style={{
                    background:
                      "radial-gradient(circle, rgba(237, 78, 1, 0.3) 0%, rgba(237, 78, 1, 0) 70%)",
                  }}
                />
              </div>
            </div>

            {/* Grid pattern overlay */}
            <div className="absolute left-1/2 top-[-429px] -translate-x-1/2 w-[1200px] h-[1120px] overflow-hidden pointer-events-none opacity-[0.06]">
              {[...Array(20)].map((_, i) => (
                <div
                  key={`v-${i}`}
                  className="absolute top-0 h-[1600px] w-px bg-[#ed4e01]"
                  style={{ left: `${79 + i * 80}px` }}
                />
              ))}
              {[...Array(20)].map((_, i) => (
                <div
                  key={`h-${i}`}
                  className="absolute left-0 w-[1600px] h-px bg-[#ed4e01]"
                  style={{ top: `${79 + i * 80}px` }}
                />
              ))}
            </div>

            {/* Content */}
            <div className="relative z-10 flex flex-col gap-[24px] sm:gap-[30px]">
              <h2
                className="text-[24px] sm:text-[30px] md:text-[36px] font-medium leading-[1.2] dark:!text-[#ffffff]"
                style={{ fontFamily: "var(--font-noto-sans)" }}
              >
                Get started today
              </h2>

              <div className="bg-white dark:bg-[#19191b] border border-[#f5eae1] dark:border-[#2f2f32] rounded-[12px] p-[16px] sm:p-[24px] flex gap-[12px] sm:gap-[32px] items-center">
                <div className="flex-1 min-h-px min-w-px overflow-x-auto">
                  <code
                    className="block text-[14px] sm:text-[16px] md:text-[18px] leading-[1.4] sm:leading-[1.6]"
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    <span className="text-[#0284c7]">
                      npm install -g @vm0/cli && vm0 onboard
                    </span>
                    <br />
                    <span className="text-[#827d77]">
                      {" "}
                      {"//"}One command to build and run your agent using
                      natural language, vibe coder friendly
                    </span>
                  </code>
                </div>
                <div className="relative">
                  <button
                    onClick={() => {
                      navigator.clipboard
                        .writeText("npm install -g @vm0/cli && vm0 onboard")
                        .catch(() => {});
                      setCopiedFooter(true);
                      setTimeout(() => setCopiedFooter(false), 2000);
                    }}
                    className="bg-[#f0ebe5] dark:bg-[#292a2e] hover:bg-[#e5dfd8] dark:hover:bg-[#3a3a3e] rounded-[10px] w-[36px] h-[36px] sm:w-[40px] sm:h-[36px] flex items-center justify-center shrink-0 transition-colors"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="shrink-0"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  {copiedFooter && (
                    <div className="absolute -top-[40px] left-1/2 -translate-x-1/2 bg-[#231f1b] text-white px-[12px] py-[6px] rounded-[6px] text-[14px] whitespace-nowrap">
                      Copied
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-[12px] sm:gap-[20px]">
                <Link
                  href="/sign-up"
                  className="bg-[#ed4e01] hover:bg-[#ff6a1f] !text-white px-[24px] py-[12px] rounded-[10px] font-medium text-[16px] sm:text-[18px] leading-[28px] w-full sm:w-[160px] transition-colors flex items-center justify-center"
                  style={{ fontFamily: "var(--font-noto-sans)" }}
                >
                  Get started
                </Link>
                <a
                  href="https://github.com/vm0-ai/vm0"
                  target="_blank"
                  rel="noreferrer"
                  className="bg-[rgba(255,255,255,0.6)] dark:bg-[rgba(25,25,27,0.6)] border border-[#ed4e01] dark:border-[#ff6a1f] hover:bg-white dark:hover:bg-[#292a2e] text-[#ed4e01] dark:text-[#ff6a1f] px-[24px] py-[12px] rounded-[10px] font-medium text-[16px] sm:text-[18px] leading-[28px] w-full sm:w-[160px] flex items-center justify-center gap-[10px] transition-colors"
                  style={{ fontFamily: "var(--font-noto-sans)" }}
                >
                  <Image
                    src="/landing/github.svg"
                    alt="GitHub"
                    width="24"
                    height="24"
                  />
                  GitHub
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}

// Helper Components
function AgentCard({
  icon,
  title,
  description,
  onClick,
  isSelected,
  variant = "white",
}: {
  icon: string | { light: string; dark: string };
  title: string;
  description: string;
  onClick?: () => void;
  isSelected?: boolean;
  variant?: "gradient-left" | "white" | "gradient-right";
}) {
  const getBackgroundClass = () => {
    if (variant === "gradient-left") {
      return "bg-gradient-to-r from-white to-transparent dark:from-[#19191b] dark:to-transparent";
    } else if (variant === "gradient-right") {
      return "bg-gradient-to-l from-white to-transparent dark:from-[#19191b] dark:to-transparent";
    } else if (variant === "white") {
      return "bg-white dark:bg-[#19191b]";
    }
    return "";
  };

  const iconLight = typeof icon === "string" ? icon : icon.light;
  const iconDark = typeof icon === "string" ? icon : icon.dark;

  return (
    <div
      onClick={onClick}
      className={`group flex flex-col flex-1 min-w-0 gap-[10px] p-[24px] border-[#f5eae1] dark:border-[#2f2f32] border-t border-b border-r overflow-hidden relative transition-all ${
        onClick
          ? "cursor-pointer hover:bg-[#fef5ee] dark:hover:bg-[#292a2e]"
          : ""
      } ${getBackgroundClass()}`}
    >
      {/* Selected state bar */}
      {isSelected && (
        <div className="absolute top-0 left-0 right-0 h-[3px] bg-primary" />
      )}
      {/* Hover state bar */}
      {!isSelected && onClick && (
        <div className="absolute top-0 left-0 right-0 h-[3px] bg-primary opacity-0 group-hover:opacity-40 transition-opacity" />
      )}
      <div className="w-[40px] h-[40px] relative shrink-0">
        <Image
          src={iconLight}
          alt={title}
          fill
          className="object-contain dark:hidden"
        />
        <Image
          src={iconDark}
          alt={title}
          fill
          className="object-contain hidden dark:block"
        />
      </div>
      <div className="flex flex-col gap-[10px] w-full">
        <h3
          className="text-[18px] font-medium leading-[28px] text-foreground"
          style={{ fontFamily: "var(--font-noto-sans)" }}
        >
          {title}
        </h3>
        <p
          className="text-[14px] leading-[20px] text-foreground"
          style={{ fontFamily: "var(--font-noto-sans)" }}
        >
          {description}
        </p>
      </div>
    </div>
  );
}
