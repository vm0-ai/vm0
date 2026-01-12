import { computed } from "ccstate";
import type { NavGroup, NavItem } from "../../types/navigation.ts";
import { pathname$ } from "../route.ts";

// Static navigation configuration - no signal needed (YAGNI)
export const NAVIGATION_CONFIG: NavGroup[] = [
  {
    label: "Your agents",
    items: [
      { id: "agents", label: "Agents", icon: "Bot", path: "/" },
      { id: "secrets", label: "Secrets", icon: "Key", path: "/" },
    ],
  },
  {
    label: "Content",
    items: [
      { id: "artifacts", label: "Artifacts", icon: "Package", path: "/" },
    ],
  },
  {
    label: "Observation",
    items: [{ id: "logs", label: "Logs", icon: "ScrollText", path: "/logs" }],
  },
  {
    label: "Developers",
    items: [{ id: "api-keys", label: "API keys", icon: "KeyRound", path: "/" }],
  },
];

// Footer navigation items (non-grouped)
export const FOOTER_NAV_ITEMS: NavItem[] = [
  { id: "bill", label: "Bill", icon: "Receipt", path: "/" },
  { id: "docs", label: "Documentation", icon: "BookOpen", path: "/" },
];

// Derived signal: active navigation item based on current pathname
export const activeNavItem$ = computed((get) => {
  const pathname = get(pathname$);

  // Check main navigation
  for (const group of NAVIGATION_CONFIG) {
    for (const item of group.items) {
      if (pathname === item.path || pathname.startsWith(item.path + "/")) {
        return item.id;
      }
    }
  }

  // Check footer navigation
  for (const item of FOOTER_NAV_ITEMS) {
    if (pathname === item.path || pathname.startsWith(item.path + "/")) {
      return item.id;
    }
  }

  return null;
});
