"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import NextLink from "next/link";
import { Link } from "../../navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "./ThemeProvider";
import { IconArrowRight } from "@tabler/icons-react";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useUser, useClerk } from "@clerk/nextjs";
import { getAppUrl } from "../../src/lib/zero/url";
import { isBlogEnabled } from "../../src/env";
interface NavbarProps {
  initialIsSignedIn?: boolean;
}

export function Navbar({ initialIsSignedIn = false }: NavbarProps) {
  const { theme } = useTheme();
  const t = useTranslations("nav");
  const { isSignedIn: clerkIsSignedIn, isLoaded } = useUser();
  const isSignedIn = isLoaded ? clerkIsSignedIn : initialIsSignedIn;
  const { signOut } = useClerk();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile menu on resize to desktop
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 768) {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => {
      return window.removeEventListener("resize", handleResize);
    };
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

  const handleSignOut = () => {
    signOut().catch((error: Error) => {
      console.error("Sign out error:", error);
    });
  };

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
                alt="VM0 - Your Trustworthy AI Teammate"
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
            <Link href="/pricing" className="nav-link">
              {t("pricing")}
            </Link>
            <Link href="/security" className="nav-link">
              {t("security")}
            </Link>
            <Link href="/use-cases" className="nav-link">
              {t("useCases")}
            </Link>
            {isBlogEnabled() && (
              <Link href="/blog" className="nav-link">
                {t("blog")}
              </Link>
            )}
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
            {!isSignedIn && (
              <>
                <a
                  href="https://calendar.app.google/csdygPrHHyNgxpTPA"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-try-demo nav-desktop"
                >
                  {t("contact")}
                </a>
                <NextLink href="/sign-up" className="btn-get-access">
                  {t("joinWaitlist")}
                </NextLink>
              </>
            )}
            {isSignedIn && (
              <>
                <button
                  onClick={handleSignOut}
                  className="btn-try-demo nav-desktop"
                >
                  {t("signOut")}
                </button>
                <a
                  href={getAppUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-get-access nav-desktop group"
                >
                  <span>{t("openApp")}</span>
                  <IconArrowRight
                    size={16}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </a>
              </>
            )}

            {/* Hamburger Menu Button */}
            <button
              className="hamburger-btn"
              onClick={() => {
                return setMobileMenuOpen(!mobileMenuOpen);
              }}
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
            <Link
              href="/security"
              className="mobile-menu-link"
              onClick={() => {
                return setMobileMenuOpen(false);
              }}
            >
              {t("security")}
            </Link>
            <Link
              href="/use-cases"
              className="mobile-menu-link"
              onClick={() => {
                return setMobileMenuOpen(false);
              }}
            >
              {t("useCases")}
            </Link>
            {isBlogEnabled() && (
              <Link
                href="/blog"
                className="mobile-menu-link"
                onClick={() => {
                  return setMobileMenuOpen(false);
                }}
              >
                {t("blog")}
              </Link>
            )}
            <a
              href="https://github.com/vm0-ai/vm0"
              target="_blank"
              rel="noopener noreferrer"
              className="mobile-menu-link"
              onClick={() => {
                return setMobileMenuOpen(false);
              }}
            >
              {t("github")}
            </a>
            <a
              href="https://calendar.app.google/csdygPrHHyNgxpTPA"
              target="_blank"
              rel="noopener noreferrer"
              className="mobile-menu-link"
              onClick={() => {
                return setMobileMenuOpen(false);
              }}
            >
              {t("contact")}
            </a>
            {isSignedIn && (
              <>
                <button
                  onClick={() => {
                    setMobileMenuOpen(false);
                    handleSignOut();
                  }}
                  className="mobile-menu-link"
                  style={{ textAlign: "left", width: "100%" }}
                >
                  {t("signOut")}
                </button>
                <a
                  href={getAppUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mobile-menu-link group"
                  onClick={() => {
                    return setMobileMenuOpen(false);
                  }}
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  <span>{t("openApp")}</span>
                  <IconArrowRight
                    size={16}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </a>
              </>
            )}
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
          onClick={() => {
            return setMobileMenuOpen(false);
          }}
        />
      )}
    </nav>
  );
}
