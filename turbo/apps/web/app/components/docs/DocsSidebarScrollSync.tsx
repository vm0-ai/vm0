"use client";

import { useEffect } from "react";

export function DocsSidebarScrollSync({ activePath }: { activePath?: string }) {
  useEffect(() => {
    const active = document.querySelector<HTMLElement>(
      ".docs-sidebar .docs-nav-link.active, .docs-sidebar .docs-nav-home.active",
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [activePath]);

  return null;
}
