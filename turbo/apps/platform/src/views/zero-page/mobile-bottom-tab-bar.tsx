import type { ReactNode } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import {
  IconMessageCircle,
  IconUsers,
  IconCalendar,
  IconMenu2,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { cn } from "@vm0/ui";
import { Link } from "../router/link.tsx";
import { activeRoute$ } from "../../signals/active-route.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import type { RouteKey } from "../../signals/route-paths.ts";
import { setSidebarExpanded$ } from "../../signals/zero-page/zero-nav.ts";

type TabIcon = (props: { size?: number; stroke?: number }) => ReactNode;

interface MobileTab {
  readonly id: "chats" | "teammates" | "schedules";
  readonly activeKeys: readonly RouteKey[];
  readonly pathname: "/" | "/agents" | "/schedules";
  readonly label: string;
  readonly icon: TabIcon;
}

const MOBILE_TABS: readonly MobileTab[] = [
  {
    id: "chats",
    activeKeys: ["home", "agentChat", "agentTalk", "agentIdeas", "chat", "chatList"],
    pathname: "/",
    label: "Chats",
    icon: IconMessageCircle as TabIcon,
  },
  {
    id: "teammates",
    activeKeys: ["agents", "agentDetail", "agentPermissions"],
    pathname: "/agents",
    label: "Teammates",
    icon: IconUsers as TabIcon,
  },
  {
    id: "schedules",
    activeKeys: ["schedules", "scheduleDetail"],
    pathname: "/schedules",
    label: "Schedules",
    icon: IconCalendar as TabIcon,
  },
] as const;

const TAB_CLASSES =
  "flex flex-1 flex-col items-center justify-center gap-0.5 h-14 text-xs font-medium no-underline transition-colors";
const ICON_SIZE = 22;
const ICON_STROKE = 1.6;

function MobileTabLink({
  tab,
  active,
}: {
  tab: MobileTab;
  active: boolean;
}) {
  const Icon = tab.icon;
  return (
    <Link
      pathname={tab.pathname}
      aria-current={active ? "page" : undefined}
      className={cn(
        TAB_CLASSES,
        active ? "text-foreground" : "text-muted-foreground",
      )}
      data-testid={`mobile-tab-${tab.id}`}
    >
      <Icon size={ICON_SIZE} stroke={ICON_STROKE} />
      <span>{tab.label}</span>
    </Link>
  );
}

function MoreTab({ active }: { active: boolean }) {
  const setExpanded = useSet(setSidebarExpanded$);
  return (
    <button
      type="button"
      onClick={() => {
        setExpanded(true);
      }}
      aria-label="Open more menu"
      className={cn(
        TAB_CLASSES,
        active ? "text-foreground" : "text-muted-foreground",
      )}
      data-testid="mobile-tab-more"
    >
      <IconMenu2 size={ICON_SIZE} stroke={ICON_STROKE} />
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
      className="md:hidden shrink-0 flex items-stretch border-t border-border/50 bg-background z-10"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Primary"
      data-testid="mobile-bottom-tab-bar"
    >
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
    </nav>
  );
}
