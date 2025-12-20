"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { useTheme } from "./ThemeProvider";
import ThemeToggle from "./ThemeToggle";
import LanguageSwitcher from "./LanguageSwitcher";

export default function Footer() {
  const { theme } = useTheme();
  const t = useTranslations("footer");

  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="footer-logo">
              <Image
                src={
                  theme === "light"
                    ? "/assets/vm0-logo-dark.svg"
                    : "/assets/vm0-logo.svg"
                }
                alt="VM0"
                width={112}
                height={28}
              />
            </div>
            <p className="footer-tagline">{t("tagline")}</p>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="footer-left">
            <p className="footer-copyright">{t("copyright")}</p>
          </div>
          <div className="footer-links">
            <a
              href="https://github.com/vm0-ai/vm0"
              target="_blank"
              rel="noopener noreferrer"
              className="footer-link"
              aria-label="GitHub"
            >
              <Image
                src="/assets/github-gray.svg"
                alt="GitHub"
                width={20}
                height={20}
              />
            </a>
            <a
              href="https://discord.gg/WMpAmHFfp6"
              target="_blank"
              rel="noopener noreferrer"
              className="footer-link"
              aria-label="Discord"
            >
              <Image
                src="/assets/discord.svg"
                alt="Discord"
                width={20}
                height={20}
              />
            </a>
            <a
              href="https://x.com/vm0_ai"
              target="_blank"
              rel="noopener noreferrer"
              className="footer-link"
              aria-label="X"
            >
              <Image src="/assets/x.svg" alt="X" width={20} height={20} />
            </a>
            <a
              href="https://www.linkedin.com/company/vm0"
              target="_blank"
              rel="noopener noreferrer"
              className="footer-link"
              aria-label="LinkedIn"
            >
              <Image
                src="/assets/linkedin.svg"
                alt="LinkedIn"
                width={20}
                height={20}
              />
            </a>
          </div>
          <div className="footer-controls">
            <ThemeToggle />
            <LanguageSwitcher />
          </div>
        </div>
      </div>
    </footer>
  );
}
