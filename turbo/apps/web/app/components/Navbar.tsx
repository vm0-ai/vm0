"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { Link } from "../../navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "./ThemeProvider";
import ThemeToggle from "./ThemeToggle";
import LanguageSwitcher from "./LanguageSwitcher";

export default function Navbar() {
  const { theme } = useTheme();
  const t = useTranslations("nav");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile menu on resize to desktop
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 768) {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  return (
    <nav className="navbar">
      <div className="container">
        <div className="nav-wrapper">
          <div className="nav-left">
            <Link href="/" className="logo">
              <Image
                src={
                  theme === "light"
                    ? "/assets/vm0-logo-dark.svg"
                    : "/assets/vm0-logo.svg"
                }
                alt="VM0 - Modern Runtime for Agent Development"
                width={120}
                height={30}
              />
            </Link>
          </div>

          {/* Desktop Navigation */}
          <div
            className="nav-center nav-desktop"
            style={{ display: "flex", gap: "32px" }}
          >
            <a
              href="https://docs.vm0.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-link"
            >
              {t("docs")}
            </a>
            <a
              href="https://blog.vm0.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-link"
            >
              {t("blog")}
            </a>
            <Link href="/skills" className="nav-link">
              {t("skills")}
            </Link>
            <a
              href="https://github.com/vm0-ai/vm0"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-link"
            >
              {t("github")}
            </a>
          </div>

          <div className="nav-right">
            {/* Desktop buttons */}
            <a
              href="https://calendar.app.google/csdygPrHHyNgxpTPA"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-try-demo nav-desktop"
            >
              {t("contact")}
            </a>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/sign-up" className="btn-get-access">
              {t("joinWaitlist")}
            </a>

            {/* Hamburger Menu Button */}
            <button
              className="hamburger-btn"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Toggle menu"
              aria-expanded={mobileMenuOpen}
            >
              <span
                className={`hamburger-line ${mobileMenuOpen ? "open" : ""}`}
              />
              <span
                className={`hamburger-line ${mobileMenuOpen ? "open" : ""}`}
              />
              <span
                className={`hamburger-line ${mobileMenuOpen ? "open" : ""}`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      <div className={`mobile-menu ${mobileMenuOpen ? "open" : ""}`}>
        <div className="mobile-menu-content">
          <div className="mobile-menu-links">
            <a
              href="https://docs.vm0.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="mobile-menu-link"
              onClick={() => setMobileMenuOpen(false)}
            >
              {t("docs")}
            </a>
            <a
              href="https://blog.vm0.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="mobile-menu-link"
              onClick={() => setMobileMenuOpen(false)}
            >
              {t("blog")}
            </a>
            <Link
              href="/skills"
              className="mobile-menu-link"
              onClick={() => setMobileMenuOpen(false)}
            >
              {t("skills")}
            </Link>
            <a
              href="https://github.com/vm0-ai/vm0"
              target="_blank"
              rel="noopener noreferrer"
              className="mobile-menu-link"
              onClick={() => setMobileMenuOpen(false)}
            >
              {t("github")}
            </a>
            <a
              href="https://calendar.app.google/csdygPrHHyNgxpTPA"
              target="_blank"
              rel="noopener noreferrer"
              className="mobile-menu-link"
              onClick={() => setMobileMenuOpen(false)}
            >
              {t("contact")}
            </a>
          </div>
          <div className="mobile-menu-controls">
            <ThemeToggle />
            <LanguageSwitcher />
          </div>
        </div>
      </div>

      {/* Overlay */}
      {mobileMenuOpen && (
        <div
          className="mobile-menu-overlay"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
    </nav>
  );
}
