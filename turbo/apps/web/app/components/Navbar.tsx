"use client";

import Image from "next/image";
import Link from "next/link";
import ThemeToggle from "./ThemeToggle";
import { useTheme } from "./ThemeProvider";

export default function Navbar() {
  const { theme } = useTheme();

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
            <Link href="/" className="nav-link">
              Home
            </Link>
            <Link href="/cookbooks" className="nav-link">
              Cookbooks
            </Link>
            <a
              href="https://github.com/vm0-ai/vm0"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-link"
            >
              GitHub
            </a>
          </div>
          <div className="nav-right">
            <ThemeToggle />
            <a href="mailto:contact@vm0.ai" className="btn-try-demo">
              Contact us
            </a>
            <Link href="/sign-up" className="btn-get-access">
              Join waitlist
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}
