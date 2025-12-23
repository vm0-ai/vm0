"use client";

import type { JSX } from "react";
import { useTranslations } from "next-intl";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";
import Particles from "./Particles";
import CopyButton from "./CopyButton";

interface CookbookMetadata {
  id: string;
  name: string;
  description: string;
  icon: string;
  docsUrl: string;
}

interface Props {
  initialCookbooks: CookbookMetadata[];
}

function getIcon(iconName: string) {
  const icons: Record<string, JSX.Element> = {
    book: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    ),
    pen: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M12 19l7-7 3 3-7 7-3-3z" />
        <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
        <path d="M2 2l7.586 7.586" />
      </svg>
    ),
    database: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      </svg>
    ),
    layers: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </svg>
    ),
    cpu: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
        <rect x="9" y="9" width="6" height="6" />
        <line x1="9" y1="1" x2="9" y2="4" />
        <line x1="15" y1="1" x2="15" y2="4" />
        <line x1="9" y1="20" x2="9" y2="23" />
        <line x1="15" y1="20" x2="15" y2="23" />
        <line x1="20" y1="9" x2="23" y2="9" />
        <line x1="20" y1="14" x2="23" y2="14" />
        <line x1="1" y1="9" x2="4" y2="9" />
        <line x1="1" y1="14" x2="4" y2="14" />
      </svg>
    ),
    video: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <polygon points="23 7 16 12 23 17 23 7" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
    ),
    globe: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
    search: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
    git: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M13 6h3a2 2 0 0 1 2 2v7" />
        <line x1="6" y1="9" x2="6" y2="21" />
      </svg>
    ),
    briefcase: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      </svg>
    ),
    chart: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
    skills: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
    ),
  };
  return icons[iconName] || icons.book;
}

export default function CookbooksClient({ initialCookbooks }: Props) {
  const t = useTranslations("cookbooks");

  // Helper to get translated name with fallback
  const getCookbookName = (cookbook: CookbookMetadata) => {
    try {
      return t(`items.${cookbook.id}.name`);
    } catch {
      return cookbook.name;
    }
  };

  // Helper to get translated description with fallback
  const getCookbookDescription = (cookbook: CookbookMetadata) => {
    try {
      return t(`items.${cookbook.id}.description`);
    } catch {
      return cookbook.description;
    }
  };

  return (
    <>
      {/* Particles Background */}
      <Particles />

      <Navbar />

      {/* Hero Section */}
      <section className="hero-section" style={{ paddingBottom: "80px" }}>
        <div className="container">
          <div>
            <h1 className="hero-title">{t("hero.title")}</h1>
            <p className="hero-description">{t("hero.description")}</p>
            <div className="hero-buttons">
              <a
                href="https://github.com/vm0-ai/vm0-cookbooks"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary-large"
              >
                {t("hero.viewOnGithub")}
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Quick Start Section */}
      <section className="section-spacing" style={{ paddingTop: 0 }}>
        <div className="container">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "1px",
              background: "var(--card-bg)",
              border: "1px solid var(--border-light)",
              borderRadius: "12px",
              overflow: "hidden",
            }}
          >
            {/* Title */}
            <div
              style={{
                background: "var(--card-bg)",
                padding: "32px 32px 16px 32px",
              }}
            >
              <h2
                style={{
                  fontFamily: '"Noto Sans", sans-serif',
                  fontSize: "28px",
                  fontWeight: 400,
                  color: "var(--text-primary)",
                  margin: 0,
                }}
              >
                {t("getStarted.title")}
              </h2>
            </div>
            {/* Step 1 */}
            <div
              style={{
                background: "var(--card-bg)",
                padding: "10px 32px",
                display: "flex",
                alignItems: "center",
                gap: "16px",
              }}
            >
              <span
                style={{
                  fontFamily: '"Fira Mono", monospace',
                  fontSize: "12px",
                  color: "var(--primary)",
                  flexShrink: 0,
                }}
              >
                01
              </span>
              <span
                style={{
                  color: "var(--text-secondary)",
                  fontFamily: '"Fira Mono", monospace',
                  fontSize: "14px",
                }}
              >
                {t("getStarted.step1")}
              </span>
              <a
                href="https://accounts.vm0.ai/waitlist"
                style={{
                  fontFamily: '"Fira Mono", monospace',
                  fontSize: "14px",
                  color: "var(--primary)",
                  textDecoration: "none",
                }}
              >
                accounts.vm0.ai/waitlist
              </a>
            </div>

            {/* Step 2 */}
            <div
              style={{
                background: "var(--card-bg)",
                padding: "10px 32px",
                display: "flex",
                alignItems: "center",
                gap: "16px",
              }}
            >
              <span
                style={{
                  fontFamily: '"Fira Mono", monospace',
                  fontSize: "12px",
                  color: "var(--primary)",
                  flexShrink: 0,
                }}
              >
                02
              </span>
              <div
                style={{
                  background: "var(--code-input-bg)",
                  borderRadius: "6px",
                  padding: "8px 14px",
                  border: "1px solid var(--code-input-border)",
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <code
                  style={{
                    fontFamily: '"Fira Mono", monospace',
                    fontSize: "14px",
                    color: "var(--text-secondary)",
                  }}
                >
                  git clone https://github.com/vm0-ai/vm0-cookbooks
                </code>
                <CopyButton text="git clone https://github.com/vm0-ai/vm0-cookbooks" />
              </div>
            </div>

            {/* Step 3 */}
            <div
              style={{
                background: "var(--card-bg)",
                padding: "10px 32px 32px 32px",
                display: "flex",
                alignItems: "center",
                gap: "16px",
              }}
            >
              <span
                style={{
                  fontFamily: '"Fira Mono", monospace',
                  fontSize: "12px",
                  color: "var(--primary)",
                  flexShrink: 0,
                }}
              >
                03
              </span>
              <div
                style={{
                  background: "var(--code-input-bg)",
                  borderRadius: "6px",
                  padding: "8px 14px",
                  border: "1px solid var(--code-input-border)",
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <code
                  style={{
                    fontFamily: '"Fira Mono", monospace',
                    fontSize: "14px",
                    color: "var(--text-secondary)",
                  }}
                >
                  cd vm0-cookbooks/101-intro
                </code>
                <CopyButton text="cd vm0-cookbooks/101-intro" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Cookbooks Grid */}
      <section className="section-spacing">
        <div className="container">
          <h2 className="section-title" style={{ marginBottom: "40px" }}>
            {t("allCookbooks.title")}
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
              gap: "24px",
            }}
          >
            {initialCookbooks.map((cookbook) => (
              <div
                key={cookbook.id}
                className="cookbook-card"
                style={{
                  background: "var(--card-bg)",
                  border: "1px solid var(--border-light)",
                  borderRadius: "16px",
                  padding: "24px",
                  transition: "all 0.3s ease",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div
                  style={{
                    marginBottom: "16px",
                  }}
                >
                  <div
                    style={{
                      width: "40px",
                      height: "40px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "rgba(237, 78, 1, 0.1)",
                      borderRadius: "10px",
                      color: "var(--primary)",
                    }}
                  >
                    <div style={{ width: "20px", height: "20px" }}>
                      {getIcon(cookbook.icon)}
                    </div>
                  </div>
                </div>
                <h3
                  style={{
                    fontFamily: '"Noto Sans", sans-serif',
                    fontSize: "20px",
                    fontWeight: 600,
                    marginBottom: "8px",
                    color: "var(--text-primary)",
                  }}
                >
                  {getCookbookName(cookbook)}
                </h3>
                <p
                  style={{
                    fontFamily: '"Fira Mono", monospace',
                    fontSize: "14px",
                    color: "var(--text-secondary)",
                    lineHeight: 1.5,
                    marginBottom: "16px",
                    flex: 1,
                  }}
                >
                  {getCookbookDescription(cookbook)}
                </p>
                <div
                  style={{
                    paddingTop: "16px",
                    borderTop: "1px solid var(--border-light)",
                    marginTop: "auto",
                  }}
                >
                  <a
                    href={cookbook.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      color: "var(--primary)",
                      textDecoration: "none",
                      fontFamily: '"Fira Mono", monospace',
                      fontSize: "14px",
                      fontWeight: 500,
                    }}
                  >
                    {t("allCookbooks.viewCookbook")}
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </svg>
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="cta-final">
        <div className="container">
          <div className="cta-card">
            <div className="cta-ellipse"></div>
            <h2 className="cta-title">{t("cta.title")}</h2>
            <p className="cta-subtitle">{t("cta.subtitle")}</p>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
              <a
                href="https://accounts.vm0.ai/waitlist"
                className="btn-primary-large"
              >
                {t("cta.joinWaitlist")}
              </a>
              <a
                href="https://github.com/vm0-ai/vm0-cookbooks"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary-large"
              >
                {t("cta.exploreCookbooks")}
              </a>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
