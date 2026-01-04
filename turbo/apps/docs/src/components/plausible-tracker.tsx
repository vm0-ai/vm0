"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, Suspense } from "react";

declare global {
  interface Window {
    plausible?: (
      event: string,
      options?: { u?: string; props?: Record<string, string | number> },
    ) => void;
  }
}

function PlausibleTrackerInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Wait for plausible to be loaded
    if (
      typeof window === "undefined" ||
      typeof window.plausible !== "function"
    ) {
      return;
    }

    const currentPath =
      pathname + (searchParams?.toString() ? `?${searchParams}` : "");

    // Use sessionStorage to persist state across component remounts
    const storageKey = "plausible-tracker";
    const stored = sessionStorage.getItem(storageKey);

    // First run - mark as initialized but don't track
    // (Plausible's script handles the initial pageview after init)
    if (!stored) {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ initialized: true, lastPath: currentPath }),
      );
      return;
    }

    const state = JSON.parse(stored);

    // Only track if path actually changed
    if (currentPath === state.lastPath) {
      return;
    }

    // Track pageview on route change
    window.plausible("pageview", { u: currentPath });
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ initialized: true, lastPath: currentPath }),
    );
  }, [pathname, searchParams]);

  return null;
}

export function PlausibleTracker() {
  return (
    <Suspense fallback={null}>
      <PlausibleTrackerInner />
    </Suspense>
  );
}
