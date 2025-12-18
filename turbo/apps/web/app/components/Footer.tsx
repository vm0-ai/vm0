"use client";

import Image from "next/image";
import { useTheme } from "./ThemeProvider";

export default function Footer() {
  const { theme } = useTheme();

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
            <p className="footer-tagline">
              The modern runtime for agent-native development
            </p>
          </div>
        </div>
        <div className="footer-bottom">
          <p className="footer-copyright">
            © 2025 VM0.ai All rights reserved.
          </p>
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
        </div>
      </div>
    </footer>
  );
}
