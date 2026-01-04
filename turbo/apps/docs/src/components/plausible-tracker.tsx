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
  const isFirstRender = useRef(true);

  useEffect(() => {
    // Skip tracking on initial mount - Plausible's script handles that
    // Only track subsequent client-side navigation
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    // Track pageview on route change
    if (typeof window !== "undefined" && window.plausible) {
      const url =
        pathname + (searchParams?.toString() ? `?${searchParams}` : "");
      window.plausible("pageview", { u: url });
    }
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
