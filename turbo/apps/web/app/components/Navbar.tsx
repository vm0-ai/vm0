"use client";

import Image from "next/image";
import { Link } from "../../navigation";
import { useTranslations } from "next-intl";
import ThemeToggle from "./ThemeToggle";
import LanguageSwitcher from "./LanguageSwitcher";
import { useTheme } from "./ThemeProvider";

export default function Navbar() {
  const { theme } = useTheme();
  const t = useTranslations("nav");

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
          <div className="nav-center" style={{ display: "flex", gap: "32px" }}>
            <a
              href="https://blog.vm0.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-link"
            >
              {t("blog")}
            </a>
            <Link href="/cookbooks" className="nav-link">
              {t("cookbooks")}
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
            <a href="mailto:contact@vm0.ai" className="btn-try-demo">
              {t("contact")}
            </a>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/sign-up" className="btn-get-access">
              {t("joinWaitlist")}
            </a>
          </div>
        </div>
      </div>
      <div className="navbar-edge-controls">
        <ThemeToggle />
        <LanguageSwitcher />
      </div>
    </nav>
  );
}
