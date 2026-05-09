"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import NextLink from "next/link";
import { Link } from "../../navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "./ThemeProvider";
import {
  IconArrowRight,
  IconArrowUpRight,
  IconChevronDown,
} from "@tabler/icons-react";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { NavMenu, type NavMenuItem } from "./NavMenu";
import { useUser, useClerk } from "@clerk/nextjs";
import { getAppUrl } from "../../src/lib/zero/url";
import { isBlogEnabled } from "../../src/env";

interface NavbarProps {
  initialIsSignedIn?: boolean;
  initialShowDocs?: boolean;
}

const GITHUB_URL = "https://github.com/vm0-ai/vm0";
const STATUS_URL = "https://status.vm0.ai";
const DEMO_URL = "https://calendar.app.google/csdygPrHHyNgxpTPA";

export function Navbar({
  initialIsSignedIn = false,
  initialShowDocs = false,
}: NavbarProps) {
  const { theme } = useTheme();
  const t = useTranslations("nav");
  const { isSignedIn: clerkIsSignedIn, isLoaded } = useUser();
  const isSignedIn = isLoaded ? clerkIsSignedIn : initialIsSignedIn;
  const { signOut } = useClerk();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 960) {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => {
      return window.removeEventListener("resize", handleResize);
    };
  }, []);

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

  const closeMobile = () => {
    setMobileMenuOpen(false);
  };

  const blogItem: NavMenuItem | null = isBlogEnabled()
    ? {
        label: t("blog"),
        description: t("blogDesc"),
        href: "/blog",
        icon: "/assets/nav/blog.png",
      }
    : null;

  const docsItem: NavMenuItem | null = initialShowDocs
    ? {
        label: t("docs"),
        description: t("docsDesc"),
        href: "/docs",
        icon: "/assets/nav/docs.svg",
      }
    : null;

  const resourcesItems: NavMenuItem[] = [
    ...(docsItem ? [docsItem] : []),
    ...(blogItem ? [blogItem] : []),
    {
      label: t("support"),
      description: t("supportDesc"),
      href: "/support",
      icon: "/assets/nav/support.png",
    },
    {
      label: t("status"),
      description: t("statusDesc"),
      href: STATUS_URL,
      icon: "/assets/nav/status.png",
      external: true,
    },
    {
      label: t("github"),
      description: t("githubDesc"),
      href: GITHUB_URL,
      icon: "/assets/nav/github.png",
      external: true,
    },
  ];

  const trustItems: NavMenuItem[] = [
    {
      label: t("models"),
      description: t("modelsDesc"),
      href: "/models",
      icon: "/assets/nav/models.png",
    },
    {
      label: t("modelRankings"),
      description: t("modelRankingsDesc"),
      href: "/rankings",
      icon: "/assets/nav/rankings.png",
    },
    {
      label: t("security"),
      description: t("securityDesc"),
      href: "/security",
      icon: "/assets/nav/security.png",
    },
  ];

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

          <div className="nav-center nav-desktop">
            <Link href="/use-cases" className="nav-link">
              {t("useCases")}
            </Link>
            <NavMenu
              id="resources"
              label={t("resources")}
              items={resourcesItems}
              alignOffset={-40}
              openId={openMenuId}
              onOpenChange={setOpenMenuId}
            />
            <NavMenu
              id="trust-and-tech"
              label={t("trustAndTech")}
              items={trustItems}
              alignOffset={40}
              openId={openMenuId}
              onOpenChange={setOpenMenuId}
            />
            <Link href="/pricing" className="nav-link">
              {t("pricing")}
            </Link>
          </div>

          <div className="nav-right">
            {!isSignedIn && (
              <>
                <a
                  href={DEMO_URL}
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

      <div className={`mobile-menu ${mobileMenuOpen ? "open" : ""}`}>
        <div className="mobile-menu-content">
          <div className="mobile-menu-links">
            <Link
              href="/use-cases"
              className="mobile-menu-link"
              onClick={closeMobile}
            >
              {t("useCases")}
            </Link>
            <Link
              href="/pricing"
              className="mobile-menu-link"
              onClick={closeMobile}
            >
              {t("pricing")}
            </Link>

            <MobileMenuGroup
              label={t("resources")}
              items={resourcesItems}
              onSelect={closeMobile}
            />
            <MobileMenuGroup
              label={t("trustAndTech")}
              items={trustItems}
              onSelect={closeMobile}
            />

            <a
              href={DEMO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mobile-menu-link"
              onClick={closeMobile}
            >
              {t("contact")}
            </a>
            {isSignedIn && (
              <>
                <button
                  onClick={() => {
                    closeMobile();
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
                  onClick={closeMobile}
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

interface MobileMenuRowProps {
  item: NavMenuItem;
  onSelect: () => void;
}

function MobileMenuRow({ item, onSelect }: MobileMenuRowProps) {
  const body = (
    <span className="mobile-menu-row-body">
      <Image
        src={item.icon}
        alt=""
        width={22}
        height={22}
        className="mobile-menu-row-icon"
      />
      <span className="mobile-menu-row-label">{item.label}</span>
      {item.external && (
        <IconArrowUpRight
          size={12}
          strokeWidth={1.8}
          className="mobile-menu-row-ext"
        />
      )}
    </span>
  );

  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        className="mobile-menu-link mobile-menu-row"
        onClick={onSelect}
      >
        {body}
      </a>
    );
  }

  return (
    <Link
      href={item.href}
      className="mobile-menu-link mobile-menu-row"
      onClick={onSelect}
    >
      {body}
    </Link>
  );
}

interface MobileMenuGroupProps {
  label: string;
  items: NavMenuItem[];
  onSelect: () => void;
}

function MobileMenuGroup({ label, items, onSelect }: MobileMenuGroupProps) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={`mobile-menu-group${open ? " mobile-menu-group-open" : ""}`}
    >
      <button
        type="button"
        className="mobile-menu-link mobile-menu-group-trigger"
        aria-expanded={open}
        onClick={() => {
          setOpen((prev) => {
            return !prev;
          });
        }}
      >
        <span>{label}</span>
        <IconChevronDown
          size={14}
          strokeWidth={1.8}
          className="mobile-menu-group-caret"
        />
      </button>
      <div className="mobile-menu-group-children">
        {items.map((item) => {
          return (
            <MobileMenuRow key={item.href} item={item} onSelect={onSelect} />
          );
        })}
      </div>
    </div>
  );
}
