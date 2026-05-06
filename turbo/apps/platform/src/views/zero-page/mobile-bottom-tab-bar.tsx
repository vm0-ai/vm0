import type { ReactNode } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import {
  IconCalendar,
  IconCalendarFilled,
  IconDots,
  IconHome,
  IconHomeFilled,
  IconPlug,
  IconUsers,
  IconUsersGroup,
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
  readonly iconActive: TabIcon;
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
    iconActive: IconHomeFilled as TabIcon,
  },
  {
    id: "agents",
    activeKeys: ["agents", "agentDetail", "agentPermissions"],
    pathname: "/agents",
    label: "Agents",
    icon: IconUsers as TabIcon,
    // Tabler doesn't ship a true filled IconUsers; the grouped variant
    // reads as "denser" and pairs well with the colored fill state.
    iconActive: IconUsersGroup as TabIcon,
  },
  {
    id: "schedules",
    activeKeys: ["schedules", "scheduleDetail"],
    pathname: "/schedules",
    label: "Scheduled",
    icon: IconCalendar as TabIcon,
    iconActive: IconCalendarFilled as TabIcon,
  },
  {
    id: "connectors",
    activeKeys: ["connectors", "directedConnect", "directedAuthorize"],
    pathname: "/connectors",
    label: "Connectors",
    icon: IconPlug as TabIcon,
    // No filled IconPlug variant ships with Tabler; the brand-color +
    // pill-bg combo carries the selected state on its own.
    iconActive: IconPlug as TabIcon,
  },
] as const;

// Slack-style: each tab is a vertical icon+label stack; the SELECTED tab
// gets a rounded pill background (bg-muted) and the icon switches to its
// filled variant tinted with the brand color. Unselected tabs stay
// stroke-only and muted.
const TAB_BASE =
  "flex flex-1 flex-col items-center justify-center gap-1 py-1.5 px-2 rounded-2xl text-[13px] leading-none no-underline transition-colors";
const TAB_ACTIVE = "bg-muted text-primary font-semibold";
const TAB_INACTIVE = "text-muted-foreground font-medium";
const ICON_SIZE = 24;
const ICON_STROKE = 1.6;

function MobileTabLink({ tab, active }: { tab: MobileTab; active: boolean }) {
  const Icon = active ? tab.iconActive : tab.icon;
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

  const matchedTabId = MOBILE_TABS.find((tab) => {
    return activeId !== null && tab.activeKeys.includes(activeId);
  })?.id;

  return (
    <nav
      className="md:hidden shrink-0 px-2 pt-1 z-10 border-t border-border/50 bg-background"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.25rem)" }}
      aria-label="Primary"
      data-testid="mobile-bottom-tab-bar"
    >
      <div className="flex items-stretch gap-1">
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
