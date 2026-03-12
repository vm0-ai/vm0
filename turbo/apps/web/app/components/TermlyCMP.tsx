"use client";

import { useEffect, useMemo, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const SCRIPT_SRC_BASE = "https://app.termly.io";

/**
 * Custom blocking map: categorize third-party domains for Termly Auto Blocker.
 * Must be set on window before the Termly script loads.
 * Categories: essential, performance, analytics, advertising, social_networking
 * @see https://support.termly.io/hc/en-us/articles/30710543325329
 */
const CUSTOM_BLOCKING_MAP: Record<string, string> = {
  "vm0.ai": "essential",
  "vm6.ai": "essential",
  "vm7.ai": "essential",
  "clerk.accounts.dev": "essential",
  "plausible.io": "analytics",
  "instatus.com": "essential",
};

interface TermlyCMPProps {
  websiteUUID: string;
  autoBlock?: boolean;
  masterConsentsOrigin?: string;
}

declare global {
  interface Window {
    Termly?: {
      initialize: () => void;
    };
    TERMLY_CUSTOM_BLOCKING_MAP?: Record<string, string>;
  }
}

export default function TermlyCMP({
  websiteUUID,
  autoBlock,
  masterConsentsOrigin,
}: TermlyCMPProps) {
  const scriptSrc = useMemo(() => {
    const src = new URL(SCRIPT_SRC_BASE);
    src.pathname = `/resource-blocker/${websiteUUID}`;
    if (autoBlock) {
      src.searchParams.set("autoBlock", "on");
    }
    if (masterConsentsOrigin) {
      src.searchParams.set("masterConsentsOrigin", masterConsentsOrigin);
    }
    return src.toString();
  }, [autoBlock, masterConsentsOrigin, websiteUUID]);

  const isScriptAdded = useRef(false);

  useEffect(() => {
    if (isScriptAdded.current) return;
    window.TERMLY_CUSTOM_BLOCKING_MAP = CUSTOM_BLOCKING_MAP;
    const script = document.createElement("script");
    script.src = scriptSrc;
    document.head.appendChild(script);
    isScriptAdded.current = true;
  }, [scriptSrc]);

  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    window.Termly?.initialize();
  }, [pathname, searchParams]);

  return null;
}
