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
// brand color carry the active state). The active pill is fully rounded
// to mirror the fully-rounded outer dock.
const TAB_BASE =
  "flex flex-1 flex-col items-center justify-center gap-1 px-2 py-2 rounded-full text-[10px] leading-none no-underline transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";
const TAB_ACTIVE = "bg-gray-100 text-foreground font-semibold";
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

  // Dock pinned to the physical screen edge via position:fixed bottom:0,
  // so in iOS PWA standalone the home-indicator translucent overlay sits
  // on top of the dock's bottom strip — matches Apple's floating dock
  // pattern (mini-player, Camera Roll). A sibling spacer reserves the
  // dock's height inside the flex column so page content scrolls above
  // it instead of behind it.
  return (
    <>
      <div
        aria-hidden="true"
        className="md:hidden shrink-0"
        style={{ height: DOCK_FLOW_HEIGHT }}
      />
      <nav
        className="md:hidden fixed inset-x-0 bottom-0 px-3 pt-2 pb-1.5 z-10"
        aria-label="Primary"
        data-testid="mobile-bottom-tab-bar"
      >
        <div className="flex items-stretch gap-0.5 p-1.5 rounded-full border border-border/60 bg-card/70 backdrop-blur-xl shadow-[0_4px_20px_-4px_rgb(0_0_0/0.06)]">
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
    </>
  );
}

// nav padding (pt-2 + pb-1.5 = 14) + pill padding (p-1.5 ×2 = 12) +
// tab content (icon 24 + gap-1 4 + label 14 + py-2 ×2 16 = 58) = 84
const DOCK_FLOW_HEIGHT = 84;
