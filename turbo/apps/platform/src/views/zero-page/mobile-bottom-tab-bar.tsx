import type { ReactNode } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import {
  IconHome,
  IconUsers,
  IconCalendar,
  IconPlug,
  IconMenu2,
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
    label: "Schedules",
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

// 64px dock + 24px icons + 13px label matches iOS HIG (10pt SF Caption ≈
// 13.3px CSS at default Dynamic Type); the previous text-xs / 22-stroke
// combo read as undersized vs. native chrome.
const TAB_CLASSES =
  "relative flex flex-1 flex-col items-center justify-center gap-1 h-16 text-[13px] leading-none font-medium no-underline transition-colors";
const ACTIVE_DOT =
  "absolute bottom-1.5 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-primary";
const ICON_SIZE = 24;
const ICON_STROKE = 1.5;

function MobileTabLink({ tab, active }: { tab: MobileTab; active: boolean }) {
  const Icon = tab.icon;
  return (
    <Link
      pathname={tab.pathname}
      aria-current={active ? "page" : undefined}
      className={cn(
        TAB_CLASSES,
        active
          ? "text-foreground font-semibold"
          : "text-muted-foreground font-medium",
      )}
      data-testid={`mobile-tab-${tab.id}`}
    >
      <Icon size={ICON_SIZE} stroke={ICON_STROKE} />
      <span>{tab.label}</span>
      {active ? <span aria-hidden className={ACTIVE_DOT} /> : null}
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
      className={cn(
        TAB_CLASSES,
        active
          ? "text-foreground font-semibold"
          : "text-muted-foreground font-medium",
      )}
      data-testid="mobile-tab-more"
    >
      <IconMenu2 size={ICON_SIZE} stroke={ICON_STROKE} />
      <span>More</span>
      {active ? <span aria-hidden className={ACTIVE_DOT} /> : null}
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
      className="md:hidden shrink-0 px-3 pt-2 z-10"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.5rem)" }}
      aria-label="Primary"
      data-testid="mobile-bottom-tab-bar"
    >
      <div className="flex items-stretch rounded-3xl border border-border/60 bg-card/70 backdrop-blur-xl shadow-[0_4px_20px_-4px_rgb(0_0_0/0.06)]">
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
