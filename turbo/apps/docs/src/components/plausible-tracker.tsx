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
