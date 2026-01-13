"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import Navbar from "./Navbar";
import Footer from "./Footer";
import { useTheme } from "./ThemeProvider";

export default function LandingPage() {
  const sandboxRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const t = useTranslations("hero");
  const tBuild = useTranslations("build");
  const tCliAgents = useTranslations("cliAgents");
  const tFeatures = useTranslations("features");
  const tInfra = useTranslations("infrastructure");
  const tCta = useTranslations("cta");

  useEffect(() => {
    const handleScroll = () => {
      const navbar = document.querySelector(".navbar") as HTMLElement;
      const currentScroll = window.pageYOffset;
      const isDarkMode =
        document.documentElement.getAttribute("data-theme") !== "light";

      if (navbar) {
        if (currentScroll > 50) {
          navbar.style.background = isDarkMode
            ? "rgba(10, 10, 10, 0.95)"
            : "rgba(255, 255, 255, 0.95)";
          navbar.style.backdropFilter = "blur(30px)";
        } else {
          navbar.style.background = isDarkMode
            ? "rgba(10, 10, 10, 0.8)"
            : "rgba(255, 255, 255, 0.8)";
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
        const x = event.clientX / window.innerWidth - 0.5;
        const y = event.clientY / window.innerHeight - 0.5;
        setTilt(x * 2, y * 2);
      };

      window.addEventListener("pointermove", handlePointerMove);

      return () => {
        window.removeEventListener("pointermove", handlePointerMove);
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
      <Navbar />

      {/* Hero Section */}
      <section className="hero-section">
        <div className="container">
          <div className="hero-grid">
            <div className="hero-text">
              <h1 className="hero-title">{t("title")}</h1>
              <p className="hero-description">{t("subtitle")}</p>
              <div className="hero-buttons">
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a href="/sign-up" className="btn-primary-large">
                  {t("joinWaitlist")}
                </a>
                <a
                  href="https://github.com/vm0-ai/vm0"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary-large"
                >
                  {t("github")}
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
          <h2 className="section-title">{tBuild("title")}</h2>
          <p className="section-description">{tBuild("description")}</p>

          <div className="comparison-wrapper">
            <div className="comparison-content">
              <div className="comparison-left">
                <div className="old-tools-grid">
                  <div className="tool-logo">
                    <Image
                      src={
                        theme === "light"
                          ? "/assets/n8n-dark.svg"
                          : "/assets/n8n.svg"
                      }
                      alt="n8n workflow automation tool"
                      width={80}
                      height={40}
                      loading="lazy"
                    />
                  </div>
                  <div className="tool-logo">
                    <Image
                      src={
                        theme === "light"
                          ? "/assets/dify-dark.svg"
                          : "/assets/dify.svg"
                      }
                      alt="Dify AI application platform"
                      width={80}
                      height={40}
                      loading="lazy"
                    />
                  </div>
                  <div className="tool-logo">
                    <Image
                      src={
                        theme === "light"
                          ? "/assets/modal-dark.svg"
                          : "/assets/modal.svg"
                      }
                      alt="Modal cloud computing platform"
                      width={80}
                      height={40}
                      loading="lazy"
                    />
                  </div>
                  <div className="tool-logo">
                    <Image
                      src={
                        theme === "light"
                          ? "/assets/e2b-dark.svg"
                          : "/assets/e2b.svg"
                      }
                      alt="E2B code interpreter sandbox"
                      width={80}
                      height={40}
                      loading="lazy"
                    />
                  </div>
                  <div className="tool-logo">
                    <Image
                      src={
                        theme === "light"
                          ? "/assets/langgraph-dark.svg"
                          : "/assets/langgraph.svg"
                      }
                      alt="LangGraph agent framework"
                      width={80}
                      height={40}
                      loading="lazy"
                    />
                  </div>
                  <div className="tool-logo">
                    <Image
                      src={
                        theme === "light"
                          ? "/assets/langfuse-dark.svg"
                          : "/assets/langfuse.svg"
                      }
                      alt="Langfuse LLM observability platform"
                      width={80}
                      height={40}
                      loading="lazy"
                    />
                  </div>
                </div>
              </div>
              <div className="comparison-divider"></div>
              <div className="comparison-right">
                <div className="vm0-logo-large">
                  <Image
                    src={
                      theme === "light"
                        ? "/assets/vm0-logo-dark.svg"
                        : "/assets/vm0-logo.svg"
                    }
                    alt="VM0"
                    width={180}
                    height={60}
                    loading="lazy"
                  />
                </div>
                <p className="vm0-tagline">{tBuild("vm0Tagline")}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CLI Agents Section */}
      <section className="section-spacing">
        <div className="container">
          <h2 className="section-title">{tCliAgents("title")}</h2>
          <p className="section-description">{tCliAgents("description")}</p>

          <div className="cli-section-wrapper">
            <div className="cli-tools-row">
              <div className="cli-tool-item">
                <div className="cli-icon-wrapper">
                  <Image
                    src={
                      theme === "light"
                        ? "/assets/claudecode-dark.svg"
                        : "/assets/claudecode.svg"
                    }
                    alt="Claude Code - AI coding assistant"
                    width={40}
                    height={40}
                    loading="lazy"
                    className="cli-icon-img"
                  />
                </div>
                <h3 className="cli-tool-name">Claude Code</h3>
              </div>
              <div className="cli-tool-item">
                <div className="cli-icon-wrapper">
                  <Image
                    src={
                      theme === "light"
                        ? "/assets/codex-dark.svg"
                        : "/assets/codex.svg"
                    }
                    alt="OpenAI Codex - AI code generation"
                    width={40}
                    height={40}
                    loading="lazy"
                    className="cli-icon-img"
                  />
                </div>
                <h3 className="cli-tool-name">Open AI Codex</h3>
              </div>
              <div className="cli-tool-item">
                <div className="cli-icon-wrapper">
                  <Image
                    src={
                      theme === "light"
                        ? "/assets/gemini-dark.svg"
                        : "/assets/gemini.svg"
                    }
                    alt="Google Gemini CLI agent"
                    width={40}
                    height={40}
                    loading="lazy"
                    className="cli-icon-img full-height"
                  />
                </div>
                <h3 className="cli-tool-name">Gemini CLI</h3>
              </div>
              <div className="cli-tool-item">
                <div className="cli-icon-wrapper">
                  <Image
                    src={
                      theme === "light"
                        ? "/assets/cursor-cli-dark.svg"
                        : "/assets/cursor-cli.svg"
                    }
                    alt="Cursor CLI - AI code editor"
                    width={40}
                    height={40}
                    loading="lazy"
                    className="cli-icon-img"
                  />
                </div>
                <h3 className="cli-tool-name">Cursor CLI</h3>
              </div>
              <div className="cli-tool-item">
                <div className="cli-icon-wrapper">
                  <Image
                    src={
                      theme === "light"
                        ? "/assets/qianwen-dark.svg"
                        : "/assets/qianwen.svg"
                    }
                    alt="Other CLI agents and tools"
                    width={40}
                    height={40}
                    loading="lazy"
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
                    alt="Marketing agent automation icon"
                    width={24}
                    height={24}
                    loading="lazy"
                  />
                </div>
                <h3 className="use-case-title">
                  {tCliAgents("marketingAgent.title")}
                </h3>
                <p className="use-case-desc">
                  {tCliAgents("marketingAgent.description")}
                </p>
              </div>
              <div className="use-case-item">
                <div className="use-case-icon-wrapper">
                  <Image
                    src="/assets/circle-five-line.svg"
                    alt="Productivity agent automation icon"
                    width={24}
                    height={24}
                    loading="lazy"
                  />
                </div>
                <h3 className="use-case-title">
                  {tCliAgents("productivityAgent.title")}
                </h3>
                <p className="use-case-desc">
                  {tCliAgents("productivityAgent.description")}
                </p>
              </div>
              <div className="use-case-item">
                <div className="use-case-icon-wrapper">
                  <Image
                    src="/assets/book-one.svg"
                    alt="Research agent icon"
                    width={24}
                    height={24}
                    loading="lazy"
                  />
                </div>
                <h3 className="use-case-title">
                  {tCliAgents("researchAgent.title")}
                </h3>
                <p className="use-case-desc">
                  {tCliAgents("researchAgent.description")}
                </p>
              </div>
              <div className="use-case-item">
                <div className="use-case-icon-wrapper">
                  <Image
                    src="/assets/code-download.svg"
                    alt="Coding agent icon"
                    width={24}
                    height={24}
                    loading="lazy"
                  />
                </div>
                <h3 className="use-case-title">
                  {tCliAgents("codingAgent.title")}
                </h3>
                <p className="use-case-desc">
                  {tCliAgents("codingAgent.description")}
                </p>
              </div>
              <div className="use-case-item">
                <div className="use-case-icon-wrapper">
                  <Image
                    src="/assets/circle-five-line.svg"
                    alt="Personalized agentic workflow icon"
                    width={24}
                    height={24}
                    loading="lazy"
                  />
                </div>
                <h3 className="use-case-title">
                  {tCliAgents("personalizedAgent.title")}
                </h3>
                <p className="use-case-desc">
                  {tCliAgents("personalizedAgent.description")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="section-spacing">
        <div className="container">
          <h2 className="section-title">{tFeatures("title")}</h2>

          <div className="features-stack">
            <div className="feature-card">
              <div className="feature-content">
                <h3 className="feature-title">
                  {tFeatures("noWorkflows.title")}
                </h3>
                <p className="feature-text">
                  {tFeatures("noWorkflows.description")}
                </p>
              </div>
              <div className="feature-visual prompt-visual">
                <Image
                  src="/assets/code_illustration.svg"
                  alt="Simple prompt-based agent configuration"
                  width={400}
                  height={300}
                  loading="lazy"
                  className="code-illustration"
                />
              </div>
            </div>

            <div className="feature-card">
              <div className="feature-content">
                <h3 className="feature-title">
                  {tFeatures("purposeBuilt.title")}
                </h3>
                <p className="feature-text">
                  {tFeatures("purposeBuilt.description")}
                </p>
              </div>
              <div className="feature-visual agent-visual">
                <Image
                  src="/assets/code_2.svg"
                  alt="Purpose-built agent runtime with session preservation"
                  width={400}
                  height={300}
                  loading="lazy"
                  className="agent-illustration"
                />
              </div>
            </div>

            <div className="feature-card">
              <div className="feature-content">
                <h3 className="feature-title">
                  {tFeatures("observable.title")}
                </h3>
                <p className="feature-text">
                  {tFeatures("observable.description")}
                </p>
              </div>
              <div className="feature-visual observable-visual">
                <Image
                  src="/assets/code_3.svg"
                  alt="Real-time agent observability and debugging"
                  width={400}
                  height={300}
                  loading="lazy"
                  className="observable-illustration"
                />
              </div>
            </div>

            <div className="feature-card">
              <div className="feature-content">
                <h3 className="feature-title">
                  {tFeatures("reproducible.title")}
                </h3>
                <p className="feature-text">
                  {tFeatures("reproducible.description")}
                </p>
              </div>
              <div className="feature-visual persistent-visual">
                <Image
                  src="/assets/code_4.svg"
                  alt="Reproducible agent checkpoints and persistence"
                  width={400}
                  height={300}
                  loading="lazy"
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
          <h2 className="section-title">{tInfra("title")}</h2>

          <div className="infra-grid">
            <div className="infra-item">
              <h3 className="infra-title">
                {tInfra("versionedStorage.title")}
              </h3>
              <p className="infra-desc">
                {tInfra("versionedStorage.description")}
              </p>
            </div>
            <div className="infra-item">
              <h3 className="infra-title">
                {tInfra("sessionContinuity.title")}
              </h3>
              <p className="infra-desc">
                {tInfra("sessionContinuity.description")}
              </p>
            </div>
            <div className="infra-item">
              <h3 className="infra-title">
                {tInfra("structuredObservability.title")}
              </h3>
              <p className="infra-desc">
                {tInfra("structuredObservability.description")}
              </p>
            </div>
            <div className="infra-item">
              <h3 className="infra-title">{tInfra("checkpoint.title")}</h3>
              <p className="infra-desc">{tInfra("checkpoint.description")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="cta-final">
        <div className="container">
          <div className="cta-card">
            <div className="cta-ellipse"></div>
            <h2 className="cta-title">{tCta("title")}</h2>
            <p className="cta-subtitle">{tCta("subtitle")}</p>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/sign-up" className="btn-primary-large">
              {tCta("button")}
            </a>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
