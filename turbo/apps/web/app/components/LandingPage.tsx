"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";

export default function LandingPage() {
  const sandboxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleScroll = () => {
      const navbar = document.querySelector(".navbar") as HTMLElement;
      const currentScroll = window.pageYOffset;

      if (navbar) {
        if (currentScroll > 50) {
          navbar.style.background = "rgba(10, 10, 10, 0.95)";
          navbar.style.backdropFilter = "blur(30px)";
        } else {
          navbar.style.background = "rgba(10, 10, 10, 0.8)";
          navbar.style.backdropFilter = "blur(20px)";
        }
      }

      const glow = document.querySelector(".sandbox-glow") as HTMLElement;
      if (glow) {
        glow.style.transform = `translate(-50%, calc(-50% + ${window.pageYOffset * 0.2}px))`;
      }
    };

    const observerOptions = {
      threshold: 0.1,
      rootMargin: "0px 0px -50px 0px",
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          (entry.target as HTMLElement).style.opacity = "1";
          (entry.target as HTMLElement).style.transform = "translateY(0)";
        }
      });
    }, observerOptions);

    const sections = document.querySelectorAll(
      ".section-spacing, .feature-card, .infra-item, .cli-tool-item, .use-case-item",
    );

    sections.forEach((section) => {
      const el = section as HTMLElement;
      el.style.opacity = "0";
      el.style.transform = "translateY(20px)";
      el.style.transition = "opacity 0.6s ease, transform 0.6s ease";
      observer.observe(section);
    });

    const hero = document.querySelector(".hero-section") as HTMLElement;
    if (hero) {
      hero.style.opacity = "1";
      hero.style.transform = "translateY(0)";
    }

    const sandboxContainer = sandboxRef.current;
    const prefersFinePointer = window.matchMedia("(pointer: fine)").matches;

    if (sandboxContainer && prefersFinePointer) {
      const setTilt = (xRatio: number, yRatio: number) => {
        const tiltX = (xRatio * 20).toFixed(2);
        const tiltY = (-yRatio * 20).toFixed(2);
        sandboxContainer.style.setProperty("--tiltX", `${tiltX}deg`);
        sandboxContainer.style.setProperty("--tiltY", `${tiltY}deg`);
      };

      const handlePointerMove = (event: PointerEvent) => {
        const rect = sandboxContainer.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        const clampedX = Math.max(0, Math.min(1, x)) - 0.5;
        const clampedY = Math.max(0, Math.min(1, y)) - 0.5;
        setTilt(clampedX * 2, clampedY * 2);
      };

      const resetTilt = () => {
        sandboxContainer.style.setProperty("--tiltX", "0deg");
        sandboxContainer.style.setProperty("--tiltY", "0deg");
      };

      sandboxContainer.addEventListener("pointermove", handlePointerMove);
      sandboxContainer.addEventListener("pointerleave", resetTilt);

      return () => {
        sandboxContainer.removeEventListener("pointermove", handlePointerMove);
        sandboxContainer.removeEventListener("pointerleave", resetTilt);
      };
    }

    window.addEventListener("scroll", handleScroll);
    return () => {
      window.removeEventListener("scroll", handleScroll);
      observer.disconnect();
    };
  }, []);

  const renderParticles = () => {
    const particles = [];
    for (let i = 0; i < 30; i++) {
      const size = i % 3 === 0 ? "large" : i % 3 === 1 ? "medium" : "small";
      particles.push(
        <div key={i} className={`particle particle-${size}`}></div>,
      );
    }
    return particles;
  };

  return (
    <>
      {/* Navigation */}
      <nav className="navbar">
        <div className="container">
          <div className="nav-wrapper">
            <div className="nav-left">
              <div className="logo">
                <Image
                  src="/assets/vm0-logo.svg"
                  alt="VM0"
                  width={120}
                  height={30}
                />
              </div>
              <span className="tagline">
                Build and evolve AI agents in natural language.
              </span>
            </div>
            <div className="nav-right">
              <a
                href="https://github.com/vm0-ai/vm0"
                target="_blank"
                rel="noopener noreferrer"
                className="nav-github"
                aria-label="GitHub"
              >
                <Image
                  src="/assets/github.svg"
                  alt="GitHub"
                  width={24}
                  height={24}
                />
              </a>
              <a href="mailto:ethan@vm0.ai" className="btn-try-demo">
                Contact us
              </a>
              <Link href="/sign-up" className="btn-get-access">
                Join waitlist
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="hero-section">
        <div className="container">
          <div className="hero-grid">
            <div className="hero-text">
              <h1 className="hero-title">
                The modern runtime for agent-native development
              </h1>
              <p className="hero-description">
                Infrastructure for AI agents, not workflows. VM0&apos;s built-in
                sandbox gives you everything you need to design, run, and
                iterate on modern agents.
              </p>
              <div className="hero-buttons">
                <Link href="/sign-up" className="btn-primary-large">
                  Join waitlist
                </Link>
                <a href="mailto:ethan@vm0.ai" className="btn-secondary-large">
                  Contact us
                </a>
              </div>
            </div>
            <div className="hero-visual">
              <div className="sandbox-container" ref={sandboxRef}>
                {/* Background Grid */}
                <div className="sandbox-grid"></div>

                {/* 3D Cube */}
                <div className="cube-wrapper">
                  <div className="cube">
                    <div className="cube-face cube-front">
                      <div className="cube-content">
                        <div className="cube-pattern"></div>
                      </div>
                    </div>
                    <div className="cube-face cube-back">
                      <div className="cube-pattern"></div>
                    </div>
                    <div className="cube-face cube-right">
                      <div className="cube-pattern"></div>
                    </div>
                    <div className="cube-face cube-left">
                      <div className="cube-pattern"></div>
                    </div>
                    <div className="cube-face cube-top">
                      <div className="cube-pattern"></div>
                    </div>
                    <div className="cube-face cube-bottom">
                      <div className="cube-pattern"></div>
                    </div>
                  </div>
                </div>

                {/* Floating Particles */}
                <div className="particles">{renderParticles()}</div>

                {/* Connection Lines */}
                <svg className="particle-connections" viewBox="0 0 2000 2000">
                  <defs>
                    <linearGradient
                      id="lineGradient"
                      x1="0%"
                      y1="0%"
                      x2="100%"
                      y2="100%"
                    >
                      <stop
                        offset="0%"
                        style={{
                          stopColor: "rgba(255, 140, 77, 0.6)",
                          stopOpacity: 1,
                        }}
                      />
                      <stop
                        offset="50%"
                        style={{
                          stopColor: "rgba(237, 78, 1, 0.4)",
                          stopOpacity: 1,
                        }}
                      />
                      <stop
                        offset="100%"
                        style={{
                          stopColor: "rgba(255, 140, 77, 0.2)",
                          stopOpacity: 0,
                        }}
                      />
                    </linearGradient>
                  </defs>
                </svg>

                {/* Code Fragments */}
                <div className="code-fragments">
                  <div className="code-fragment">vm0</div>
                  <div className="code-fragment">agent</div>
                  <div className="code-fragment">sandbox</div>
                  <div className="code-fragment">deploy</div>
                </div>

                {/* Glow Effect */}
                <div className="sandbox-glow"></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Build Agents Section */}
      <section className="section-spacing">
        <div className="container">
          <h2 className="section-title">Build agents in a modern way</h2>
          <p className="section-description">
            Today&apos;s options fall into two buckets: tools that only run
            containers, and workflow builders that are too rigid for real agent
            behavior. Developers still lack an environment built for
            agent-native execution. VM0 bridges this gap with an end to end
            agent-native runtime.
          </p>

          <div className="comparison-wrapper">
            <div className="comparison-content">
              <div className="comparison-left">
                <div className="old-tools-grid">
                  <div className="tool-logo">
                    <Image
                      src="/assets/n8n.svg"
                      alt="n8n"
                      width={80}
                      height={40}
                    />
                  </div>
                  <div className="tool-logo">
                    <Image
                      src="/assets/dify.svg"
                      alt="Dify"
                      width={80}
                      height={40}
                    />
                  </div>
                  <div className="tool-logo">
                    <Image
                      src="/assets/modal.svg"
                      alt="Modal"
                      width={80}
                      height={40}
                    />
                  </div>
                  <div className="tool-logo">
                    <Image
                      src="/assets/e2b.svg"
                      alt="E2B"
                      width={80}
                      height={40}
                    />
                  </div>
                  <div className="tool-logo">
                    <Image
                      src="/assets/langgraph.svg"
                      alt="LangGraph"
                      width={80}
                      height={40}
                    />
                  </div>
                </div>
              </div>
              <div className="comparison-divider"></div>
              <div className="comparison-right">
                <div className="vm0-logo-large">
                  <Image
                    src="/assets/vm0-logo.svg"
                    alt="VM0"
                    width={180}
                    height={60}
                  />
                </div>
                <p className="vm0-tagline">
                  Build and evolve AI agents, just natural language.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CLI Agents Section */}
      <section className="section-spacing">
        <div className="container">
          <h2 className="section-title">
            Support all kinds of CLI-based agents
          </h2>
          <p className="section-description">
            Use Claude Code, Codex, Gemini, and other CLI agents to build your
            own. VM0 fits into any agent development and provides the
            infrastructure you need to create vertical, end-user-facing agents.
          </p>

          <div className="cli-section-wrapper">
            <div className="cli-tools-row">
              <div className="cli-tool-item">
                <div className="cli-icon-wrapper">
                  <Image
                    src="/assets/claudecode.svg"
                    alt="Claude"
                    width={40}
                    height={40}
                    className="cli-icon-img"
                  />
                </div>
                <h3 className="cli-tool-name">Claude code</h3>
              </div>
              <div className="cli-tool-item">
                <div className="cli-icon-wrapper">
                  <Image
                    src="/assets/codex.svg"
                    alt="OpenAI"
                    width={40}
                    height={40}
                    className="cli-icon-img"
                  />
                </div>
                <h3 className="cli-tool-name">Open AI Codex</h3>
              </div>
              <div className="cli-tool-item">
                <div className="cli-icon-wrapper">
                  <Image
                    src="/assets/gemini.svg"
                    alt="Gemini"
                    width={40}
                    height={40}
                    className="cli-icon-img full-height"
                  />
                </div>
                <h3 className="cli-tool-name">Gemini CLI</h3>
              </div>
              <div className="cli-tool-item">
                <div className="cli-icon-wrapper">
                  <Image
                    src="/assets/cursor-cli.svg"
                    alt="Cursor"
                    width={40}
                    height={40}
                    className="cli-icon-img"
                  />
                </div>
                <h3 className="cli-tool-name">Cursor CLI</h3>
              </div>
              <div className="cli-tool-item">
                <div className="cli-icon-wrapper">
                  <Image
                    src="/assets/qianwen.svg"
                    alt="Other"
                    width={40}
                    height={40}
                    className="cli-icon-img"
                  />
                </div>
                <h3 className="cli-tool-name">Other CLI</h3>
              </div>
            </div>

            <div className="use-cases-row">
              <div className="use-case-item">
                <div className="use-case-icon-wrapper">
                  <Image
                    src="/assets/computer.svg"
                    alt="Computer"
                    width={24}
                    height={24}
                  />
                </div>
                <h3 className="use-case-title">Marketing agent</h3>
                <p className="use-case-desc">
                  A protected space for marketing agents to run tasks and refine
                  campaigns risk-free
                </p>
              </div>
              <div className="use-case-item">
                <div className="use-case-icon-wrapper">
                  <Image
                    src="/assets/circle-five-line.svg"
                    alt="Circle Five"
                    width={24}
                    height={24}
                  />
                </div>
                <h3 className="use-case-title">Productivity agent</h3>
                <p className="use-case-desc">
                  Run actions and refine routines safely, with full control and
                  zero risk to production
                </p>
              </div>
              <div className="use-case-item">
                <div className="use-case-icon-wrapper">
                  <Image
                    src="/assets/book-one.svg"
                    alt="Book"
                    width={24}
                    height={24}
                  />
                </div>
                <h3 className="use-case-title">Deep research agent</h3>
                <p className="use-case-desc">
                  Gather information, analyze sources, and iterate safely in an
                  isolated workspace
                </p>
              </div>
              <div className="use-case-item">
                <div className="use-case-icon-wrapper">
                  <Image
                    src="/assets/code-download.svg"
                    alt="Code Download"
                    width={24}
                    height={24}
                  />
                </div>
                <h3 className="use-case-title">Coding agent</h3>
                <p className="use-case-desc">
                  Safely run code, interact with I/O, access the web, and
                  execute terminal operations
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="section-spacing">
        <div className="container">
          <h2 className="section-title">
            We design a smarter, better agent development experience for you
          </h2>

          <div className="features-stack">
            <div className="feature-card">
              <div className="feature-content">
                <h3 className="feature-title">
                  No more workflows. It can be simple as just one prompt.
                </h3>
                <p className="feature-text">
                  No drag-and-drop needed — write a prompt or any type of
                  configure files, connect it to VM0, and your agent&apos;s core
                  logic is ready.
                </p>
              </div>
              <div className="feature-visual prompt-visual">
                <Image
                  src="/assets/code_illustration.svg"
                  alt="Code Illustration"
                  width={400}
                  height={300}
                  className="code-illustration"
                />
              </div>
            </div>

            <div className="feature-card">
              <div className="feature-content">
                <h3 className="feature-title">
                  Purpose-built for agents, not just code
                </h3>
                <p className="feature-text">
                  Traditional containers run programs. VM0 runs agents,
                  preserving their sessions, memory, and reasoning context. It
                  understands agents as stateful, iterative processes, not
                  one-off scripts.
                </p>
              </div>
              <div className="feature-visual agent-visual">
                <Image
                  src="/assets/code_2.svg"
                  alt="Agent Illustration"
                  width={400}
                  height={300}
                  className="agent-illustration"
                />
              </div>
            </div>

            <div className="feature-card">
              <div className="feature-content">
                <h3 className="feature-title">Observable by design</h3>
                <p className="feature-text">
                  Every run is transparent. You can see logs, metrics, and tool
                  calls in real time, no more black-box containers. Debug,
                  replay, and monitor every step of the agent lifecycle.
                </p>
              </div>
              <div className="feature-visual observable-visual">
                <Image
                  src="/assets/code_3.svg"
                  alt="Observable Illustration"
                  width={400}
                  height={300}
                  className="observable-illustration"
                />
              </div>
            </div>

            <div className="feature-card">
              <div className="feature-content">
                <h3 className="feature-title">Reproducible and persistent</h3>
                <p className="feature-text">
                  Each run creates a checkpoint you can restore, fork, or
                  optimize. Sessions and artifacts persist across runs and
                  environments. Agents keep their memory. Developers keep
                  control.
                </p>
              </div>
              <div className="feature-visual persistent-visual">
                <Image
                  src="/assets/code_4.svg"
                  alt="Persistent Illustration"
                  width={400}
                  height={300}
                  className="persistent-illustration"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Infrastructure Section */}
      <section className="section-spacing">
        <div className="container">
          <h2 className="section-title">
            VM0 is AI infrastructure built for the next paradigm
          </h2>

          <div className="infra-grid">
            <div className="infra-item">
              <h3 className="infra-title">Versioned artifact storage</h3>
              <p className="infra-desc">
                Sync files instantly between your sandbox and cloud storage,
                prewarmed before runtime.
              </p>
            </div>
            <div className="infra-item">
              <h3 className="infra-title">Session continuity</h3>
              <p className="infra-desc">
                Automatically persists CLI agent sessions and memory, unaffected
                by container lifetimes.
              </p>
            </div>
            <div className="infra-item">
              <h3 className="infra-title">Structured observability</h3>
              <p className="infra-desc">
                Stream every log, metric, and token trace through a clean API or
                dashboard, no manual logging needed.
              </p>
            </div>
            <div className="infra-item">
              <h3 className="infra-title">Checkpoint & replay</h3>
              <p className="infra-desc">
                Each run creates a checkpoint snapshot. Reattach, replay, or
                tweak the prompt anytime.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="cta-final">
        <div className="container">
          <div className="cta-card">
            <div className="cta-ellipse"></div>
            <h2 className="cta-title">
              Build and evolve AI agents inside their own reality
            </h2>
            <p className="cta-subtitle">
              {"//"} build logic, not infrastructure
            </p>
            <Link href="/sign-up" className="btn-primary-large">
              Join waitlist
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <div className="container">
          <div className="footer-content">
            <div className="footer-brand">
              <div className="footer-logo">
                <Image
                  src="/assets/vm0-logo.svg"
                  alt="VM0"
                  width={112}
                  height={28}
                />
              </div>
              <p className="footer-tagline">
                Modern infrastructure for agent development
              </p>
            </div>
          </div>
          <div className="footer-bottom">
            <p className="footer-copyright">
              © 2025 VM0.ai All rights reserved.
            </p>
            <a href="mailto:ethan@vm0.ai" className="footer-link">
              Contact us
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
