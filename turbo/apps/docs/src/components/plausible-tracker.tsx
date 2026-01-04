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
  const lastTrackedPath = useRef<string>("");

  useEffect(() => {
    // Skip tracking on initial mount - Plausible's script handles that
    if (isFirstRender.current) {
      isFirstRender.current = false;
      lastTrackedPath.current =
        pathname + (searchParams?.toString() ? `?${searchParams}` : "");
      return;
    }

    const currentPath =
      pathname + (searchParams?.toString() ? `?${searchParams}` : "");

    // Only track if path actually changed
    if (currentPath === lastTrackedPath.current) {
      return;
    }

    // Track pageview on route change
    if (
      typeof window !== "undefined" &&
      typeof window.plausible === "function"
    ) {
      window.plausible("pageview", { u: currentPath });
      lastTrackedPath.current = currentPath;
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
