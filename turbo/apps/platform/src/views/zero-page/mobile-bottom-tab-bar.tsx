import type { ReactNode } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import {
  IconCalendar,
  IconDots,
  IconHome,
  IconPlug,
  IconUsers,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { cn } from "@vm0/ui";
import { Link } from "../router/link.tsx";
import { activeRoute$ } from "../../signals/active-route.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import type { RouteKey } from "../../signals/route-paths.ts";
import { setMobileMoreSheetOpen$ } from "../../signals/zero-page/zero-nav.ts";

type TabIcon = (props: { size?: number; stroke?: number }) => ReactNode;

interface MobileTab {
  readonly id: "home" | "agents" | "schedules" | "connectors";
  readonly activeKeys: readonly RouteKey[];
  readonly pathname: "/" | "/agents" | "/schedules" | "/connectors";
  readonly label: string;
  readonly icon: TabIcon;
}

const MOBILE_TABS: readonly MobileTab[] = [
  {
    id: "home",
    activeKeys: [
      "home",
      "agentChat",
      "agentTalk",
      "agentIdeas",
      "chat",
      "chatList",
    ],
    pathname: "/",
    label: "Home",
    icon: IconHome as TabIcon,
  },
  {
    id: "agents",
    activeKeys: ["agents", "agentDetail", "agentPermissions"],
    pathname: "/agents",
    label: "Agents",
    icon: IconUsers as TabIcon,
  },
  {
    id: "schedules",
    activeKeys: ["schedules", "scheduleDetail"],
    pathname: "/schedules",
    label: "Scheduled",
    icon: IconCalendar as TabIcon,
  },
  {
    id: "connectors",
    activeKeys: ["connectors", "directedConnect", "directedAuthorize"],
    pathname: "/connectors",
    label: "Connectors",
    icon: IconPlug as TabIcon,
  },
] as const;

// Each tab: icon + label, same outline icon in both states (we don't
// shape-swap the icon between selected and unselected — the pill bg +
// brand color carry the active state). The pill sits inside a 6px-padded
// glass dock; its corner radius (rounded-[18px]) is the dock's
// rounded-3xl (24px) minus the 6px inset, so the inner and outer corners
// stay concentric.
const TAB_BASE =
  "flex flex-1 flex-col items-center justify-center gap-1 px-2 py-2 rounded-[18px] text-[11px] leading-none no-underline transition-colors";
const TAB_ACTIVE = "bg-foreground/5 text-primary font-semibold";
const TAB_INACTIVE = "text-muted-foreground font-medium";
const ICON_SIZE = 24;
const ICON_STROKE = 1.6;

function MobileTabLink({ tab, active }: { tab: MobileTab; active: boolean }) {
  const Icon = tab.icon;
  return (
    <Link
      pathname={tab.pathname}
      aria-current={active ? "page" : undefined}
      className={cn(TAB_BASE, active ? TAB_ACTIVE : TAB_INACTIVE)}
      data-testid={`mobile-tab-${tab.id}`}
    >
      <Icon size={ICON_SIZE} stroke={ICON_STROKE} />
      <span>{tab.label}</span>
    </Link>
  );
}

function MoreTab({ active }: { active: boolean }) {
  const setOpen = useSet(setMobileMoreSheetOpen$);
  return (
    <button
      type="button"
      onClick={() => {
        setOpen(true);
      }}
      aria-label="Open more menu"
      className={cn(TAB_BASE, active ? TAB_ACTIVE : TAB_INACTIVE)}
      data-testid="mobile-tab-more"
    >
      <IconDots size={ICON_SIZE} stroke={ICON_STROKE} />
      <span>More</span>
    </button>
  );
}

export function MobileBottomTabBar() {
  const features = useLastResolved(featureSwitch$);
  const enabled = features?.[FeatureSwitchKey.MobileNativeV1] ?? false;
  const activeId = useGet(activeRoute$);

  if (!enabled) {
    return null;
  }

  // Bottom nav is persistent on every top-level destination — the four
  // tab routes (chatList / agents / schedules / connectors) and the three
  // surfaces reached from the More tab (insights / works / account). It
  // only hides on deep / detail pages (chat thread, agent detail, OAuth
  // flows, schedule detail, activity detail) where the user needs an
  // immersive view.
  if (activeId === null) {
    return null;
  }
  const TAB_ROUTES: readonly RouteKey[] = [
    "home",
    "chatList",
    "agents",
    "schedules",
    "connectors",
    "insights",
    "works",
    "account",
  ];
  if (!TAB_ROUTES.includes(activeId)) {
    return null;
  }

  const matchedTabId = MOBILE_TABS.find((tab) => {
    return activeId !== null && tab.activeKeys.includes(activeId);
  })?.id;

  // Flat 6px gap below the dock on every device. We deliberately ignore
  // env(safe-area-inset-bottom) — in PWA standalone mode it returns the
  // full ~34pt home-indicator inset and stranded the dock high above the
  // screen edge. The home indicator is a translucent system overlay and
  // won't be obscured at this short distance (matches Apple's floating
  // mini-player + Camera Roll docks).
  return (
    <nav
      className="md:hidden shrink-0 px-3 pt-2 pb-1.5 z-10"
      aria-label="Primary"
      data-testid="mobile-bottom-tab-bar"
    >
      <div className="flex items-stretch gap-0.5 p-1.5 rounded-3xl border border-border/60 bg-card/70 backdrop-blur-xl shadow-[0_4px_20px_-4px_rgb(0_0_0/0.06)]">
        {MOBILE_TABS.map((tab) => {
          return (
            <MobileTabLink
              key={tab.id}
              tab={tab}
              active={matchedTabId === tab.id}
            />
          );
        })}
        <MoreTab active={matchedTabId === undefined} />
      </div>
    </nav>
  );
}
