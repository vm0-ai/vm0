"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, Suspense } from "react";

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
  const lastTrackedPath = useRef<string>("");

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

    // Initialize on first run - store initial path but don't track
    // (Plausible's script handles the initial pageview after init)
    if (lastTrackedPath.current === "") {
      lastTrackedPath.current = currentPath;
      return;
    }

    // Only track if path actually changed
    if (currentPath === lastTrackedPath.current) {
      return;
    }

    // Track pageview on route change
    window.plausible("pageview", { u: currentPath });
    lastTrackedPath.current = currentPath;
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
