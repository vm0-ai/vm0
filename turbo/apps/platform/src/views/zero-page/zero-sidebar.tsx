import type { ReactNode } from "react";
import { useLastResolved, useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  IconChartLine,
  IconLayoutGrid,
  IconPackage,
  IconRoute,
  IconUsers,
  IconEdit,
  IconChevronRight,
  IconLayoutSidebarLeftCollapse,
  IconPlug,
  IconSparkles,
  IconSearch,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@vm0/ui";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  sidebarOff$,
  toggleSidebarOff$,
  sidebarExpanded$,
  setSidebarExpanded$,
  handleZeroNavSelect$,
  handleZeroAccountAction$,
  type SidebarNavId,
} from "../../signals/zero-page/zero-nav.ts";
import { activeRoute$ } from "../../signals/active-route.ts";
import type { RouteKey } from "../../signals/route-paths.ts";
import { defaultAgentName$ } from "../../signals/agent.ts";
import {
  manageSectionCollapsed$,
  setManageSectionCollapsed$,
  openAgentListDialog$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import {
  ZeroOrgSwitcher,
  ZeroOrgSwitcherCompact,
} from "./zero-org-switcher.tsx";
import { Link } from "../router/link.tsx";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { slackOrgScopeMismatch$ } from "../../signals/zero-page/zero-slack.ts";

import { AccountDropdown } from "./zero-sidebar-account.tsx";
import { ChatThreadsSection } from "./sidebar-threads.tsx";
import { PinnedAgentListSection } from "./zero-sidebar-pinned.tsx";
import { SidebarUpgradeCard } from "./zero-sidebar-upgrade.tsx";

export { AccountDropdown } from "./zero-sidebar-account.tsx";

type NavIcon = (props: { size?: number; className?: string }) => ReactNode;

const slackIcon = settingsIconAssetUrl("slack");

type ManageNavId =
  | "activities"
  | "agents"
  | "artifacts"
  | "connectors"
  | "workflows";

interface ManageNavItem {
  readonly id: ManageNavId;
  readonly activeKeys: readonly RouteKey[];
  readonly pathname: string;
  readonly icon: NavIcon;
  readonly featureGate?: FeatureSwitchKey;
}

const MANAGE_NAV: readonly ManageNavItem[] = [
  {
    id: "agents",
    activeKeys: ["agents", "agentDetail", "agentPermissions"],
    pathname: "/agents",
    icon: IconUsers as NavIcon,
  },
  {
    id: "workflows",
    activeKeys: [
      "workflows",
      "workflowDetail",
      "workflowDetailAutomations",
      "workflowDetailInstructions",
      "workflowDetailInfo",
    ],
    pathname: "/workflows",
    icon: IconRoute as NavIcon,
  },
  {
    id: "connectors",
    activeKeys: ["connectors"],
    pathname: "/connectors",
    icon: IconPlug as NavIcon,
  },
  {
    id: "artifacts",
    activeKeys: ["artifacts"],
    pathname: "/artifacts",
    icon: IconPackage as NavIcon,
  },
  {
    id: "activities",
    activeKeys: ["activities", "activityDetail", "activityInspect"],
    pathname: "/activities",
    icon: IconChartLine as NavIcon,
    featureGate: FeatureSwitchKey.ZeroDebug,
  },
];

interface FooterNavItem {
  readonly id: "works";
  readonly activeKeys: readonly RouteKey[];
  readonly pathname: string;
  readonly icon: NavIcon;
  readonly iconImg: string | undefined;
}

const FOOTER_NAV = [
  {
    id: "works",
    activeKeys: ["works"],
    pathname: "/works",
    icon: IconLayoutGrid as NavIcon,
    iconImg: slackIcon,
  },
] as const satisfies readonly FooterNavItem[];

// Shared subscription hooks. Each sibling component pulls its own state from
// signals via these instead of receiving anything from a parent through props.

function useResolvedNavItems() {
  const { t } = useTranslation();
  const features = useLastResolved(featureSwitch$);
  const defaultDisplayName = useLastResolved(defaultAgentName$) ?? "Zero";
  const manageLabel = (id: ManageNavId): string => {
    switch (id) {
      case "activities": {
        return t(($) => {
          return $.appShell.sidebar.navigation.activity;
        });
      }
      case "agents": {
        return t(($) => {
          return $.appShell.sidebar.navigation.agents;
        });
      }
      case "artifacts": {
        return t(($) => {
          return $.appShell.sidebar.navigation.artifacts;
        });
      }
      case "connectors": {
        return t(($) => {
          return $.appShell.sidebar.navigation.connectors;
        });
      }
      case "workflows": {
        return t(($) => {
          return $.appShell.sidebar.navigation.workflows;
        });
      }
    }
  };
  const manageNav = MANAGE_NAV.filter((item) => {
    return !item.featureGate || features?.[item.featureGate];
  }).map((item) => {
    return { ...item, label: manageLabel(item.id) };
  });
  const footerNav = FOOTER_NAV.map((item) => {
    return {
      ...item,
      label: t(
        ($) => {
          return $.appShell.sidebar.navigation.works;
        },
        { agentName: defaultDisplayName },
      ),
    };
  });
  return { manageNav, footerNav };
}

function useNavSelect() {
  const rawOnSelect = useSet(handleZeroNavSelect$);
  const setExpanded = useSet(setSidebarExpanded$);
  const pageSignal = useGet(pageSignal$);
  return (id: SidebarNavId) => {
    rawOnSelect(id, pageSignal);
    setExpanded(false);
  };
}

function useSidebarCollapseToggle() {
  const toggleOff = useSet(toggleSidebarOff$);
  const setExpanded = useSet(setSidebarExpanded$);
  return () => {
    setExpanded(false);
    toggleOff();
  };
}

// Wraps AccountDropdown with the handler subscription so siblings don't have
// to thread onAccountAction through props.
function AccountDropdownContainer({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const onAccountAction = useSet(handleZeroAccountAction$);
  const settingsOwnerId = collapsed ? "sidebar-collapsed" : "sidebar-expanded";
  return (
    <AccountDropdown
      onAccountAction={onAccountAction}
      settingsOwnerId={settingsOwnerId}
      collapsed={collapsed}
    />
  );
}

// --- Collapsed icon-only sidebar (desktop, only when sidebarOff) ---

function CollapsedSidebar() {
  const off = useGet(sidebarOff$);
  if (!off) {
    return null;
  }
  return (
    <aside className="zero-nav zero-collapsed-sidebar box-border hidden md:flex h-full w-16 shrink-0 flex-col border-r-[0.7px] border-sidebar-border bg-sidebar px-2 transition-all duration-300">
      <div className="zero-desktop-titlebar-drag-region" aria-hidden="true" />
      <CollapsedExpandButton />
      <CollapsedNavList />
      <CollapsedFooter />
    </aside>
  );
}

function CollapsedExpandButton() {
  const onCollapse = useSidebarCollapseToggle();
  const { t } = useTranslation();
  const expandLabel = t(($) => {
    return $.appShell.sidebar.expand;
  });
  return (
    <div className="flex w-full shrink-0 justify-center pt-3 pb-1">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-[hsl(var(--gray-200))] hover:text-sidebar-foreground"
              onClick={onCollapse}
              aria-label={expandLabel}
            >
              <IconLayoutSidebarLeftCollapse size={18} className="rotate-180" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p className="text-xs">{expandLabel}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function CollapsedNavList() {
  const activeId = useGet(activeRoute$);
  const slackScopeMismatch = useLastResolved(slackOrgScopeMismatch$) ?? false;
  const onSelect = useNavSelect();
  const { manageNav, footerNav } = useResolvedNavItems();
  const { t } = useTranslation();
  const allNavItems = [
    ...manageNav.map(({ id, activeKeys, pathname: p, label, icon }) => {
      return { id, activeKeys, pathname: p, label, icon };
    }),
    {
      id: "chat" as const,
      activeKeys: ["home", "agentChat", "agentIdeas", "chat"] as RouteKey[],
      pathname: "/",
      label: t(($) => {
        return $.appShell.sidebar.navigation.newChat;
      }),
      icon: IconEdit as NavIcon,
    },
    ...footerNav.map(({ id, activeKeys, pathname: p, label, icon }) => {
      return { id, activeKeys, pathname: p, label, icon };
    }),
  ];
  return (
    <nav
      aria-label={t(($) => {
        return $.appShell.sidebar.ariaLabel;
      })}
      className="flex min-h-0 w-full min-w-0 flex-1 flex-col items-center gap-1 pb-2 pt-0"
    >
      <TooltipProvider delayDuration={100}>
        {allNavItems.map(
          ({ id, activeKeys, pathname: navPath, label, icon: Icon }) => {
            const isActive =
              activeId !== null &&
              (activeKeys as readonly RouteKey[]).includes(activeId);
            return (
              <div key={id} className="flex w-full shrink-0 justify-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      pathname={
                        navPath as Parameters<typeof Link>[0]["pathname"]
                      }
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey) {
                          return;
                        }
                        e.preventDefault();
                        onSelect(id);
                      }}
                      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 ${
                        isActive
                          ? "bg-gray-200 text-gray-900"
                          : "text-sidebar-foreground hover:bg-sidebar-accent"
                      }`}
                      aria-label={label}
                    >
                      <span className="relative inline-flex">
                        <Icon size={16} className="shrink-0" />
                        {id === "works" && slackScopeMismatch && (
                          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500" />
                        )}
                      </span>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p className="text-xs">{label}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          },
        )}
      </TooltipProvider>
    </nav>
  );
}

function CollapsedFooter() {
  const activeId = useGet(activeRoute$);
  const onSelect = useNavSelect();
  const { t } = useTranslation();
  const insightsLabel = t(($) => {
    return $.appShell.sidebar.navigation.insightsAndUsage;
  });
  return (
    <div className="flex w-full shrink-0 flex-col items-center gap-1 pb-2 pt-1">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              pathname="/insights"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey) {
                  return;
                }
                e.preventDefault();
                onSelect("insights");
              }}
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 ${
                activeId === "insights"
                  ? "bg-gray-200 text-gray-900"
                  : "text-sidebar-foreground hover:bg-sidebar-accent"
              }`}
              aria-label={insightsLabel}
            >
              <IconSparkles size={16} className="shrink-0" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p className="text-xs">{insightsLabel}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <AccountDropdownContainer collapsed />
    </div>
  );
}

// --- Expanded full sidebar (desktop default, mobile overlay when expanded) ---

function ExpandedSidebar({ mobileOnly = false }: { mobileOnly?: boolean }) {
  const off = useGet(sidebarOff$);
  const expanded = useGet(sidebarExpanded$);
  // When the three-column layout owns the desktop columns, this full sidebar is
  // reused solely as the mobile drawer, so it hides on desktop instead of showing.
  const visibility = mobileOnly
    ? "hidden data-[sidebar-expanded]:max-md:flex md:hidden"
    : "hidden md:flex data-[sidebar-off]:md:hidden data-[sidebar-expanded]:max-md:flex";
  return (
    <aside
      data-sidebar-off={off || undefined}
      data-sidebar-expanded={expanded || undefined}
      className={cn(
        "zero-nav zero-pwa-fixed-cover zero-mobile-fixed-safe-area h-full w-[300px] shrink-0 flex-col border-r-[0.7px] border-sidebar-border bg-sidebar transition-all duration-300 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:h-auto max-md:shadow-xl",
        visibility,
      )}
    >
      <ExpandedHeader />
      <ExpandedMainNav />
      <ExpandedUpgradeSection />
      <ExpandedFooter />
    </aside>
  );
}

function ExpandedHeader() {
  const onCollapse = useSidebarCollapseToggle();
  const { t } = useTranslation();
  const collapseLabel = t(($) => {
    return $.appShell.sidebar.collapse;
  });
  return (
    <div className="zero-sidebar-header shrink-0 px-2 pb-0">
      <div className="zero-desktop-titlebar-drag-region" aria-hidden="true" />
      <div className="zero-desktop-no-drag flex items-center justify-between gap-2 rounded-lg py-0.5">
        <div className="min-w-0 flex-1">
          <ZeroOrgSwitcher />
        </div>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-[hsl(var(--gray-200))] transition-colors"
                onClick={onCollapse}
                aria-label={collapseLabel}
              >
                <IconLayoutSidebarLeftCollapse size={18} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">{collapseLabel}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

function ExpandedMainNav() {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t(($) => {
        return $.appShell.sidebar.ariaLabel;
      })}
      className="flex-1 flex flex-col min-h-0 overflow-hidden p-2 pt-1"
    >
      <ExpandedManageSection />
      <ExpandedSidebarSections />
    </nav>
  );
}

function ExpandedManageSection() {
  const activeId = useGet(activeRoute$);
  const onSelect = useNavSelect();
  const { manageNav } = useResolvedNavItems();
  const manageCollapsed = useGet(manageSectionCollapsed$);
  const setManageCollapsed = useSet(setManageSectionCollapsed$);
  const { t } = useTranslation();
  return (
    <div className="shrink-0">
      <div
        className="group flex h-8 shrink-0 cursor-pointer items-center justify-between rounded-lg pl-2 pr-0 hover:bg-sidebar-accent transition-colors"
        onClick={() => {
          return setManageCollapsed(!manageCollapsed);
        }}
      >
        <span className="flex flex-1 items-center gap-1 truncate text-[13px] font-medium leading-4 text-sidebar-foreground/50 group-hover:text-sidebar-foreground transition-colors">
          {t(($) => {
            return $.appShell.sidebar.manage;
          })}
          <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <IconChevronRight
              size={12}
              stroke={2}
              className={manageCollapsed ? "" : "rotate-90"}
            />
          </span>
        </span>
      </div>
      {!manageCollapsed && (
        <div className="flex flex-col gap-1">
          {manageNav.map(
            ({ id, activeKeys, pathname: navPath, label, icon: Icon }) => {
              const isActive =
                activeId !== null &&
                (activeKeys as readonly RouteKey[]).includes(activeId);
              return (
                <Link
                  key={id}
                  pathname={navPath as Parameters<typeof Link>[0]["pathname"]}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) {
                      return;
                    }
                    e.preventDefault();
                    onSelect(id);
                  }}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                    isActive
                      ? "bg-gray-200 text-gray-900 font-medium"
                      : "text-sidebar-foreground hover:bg-sidebar-accent"
                  }`}
                >
                  <Icon size={16} className="shrink-0" />
                  <span className="truncate">{label}</span>
                </Link>
              );
            },
          )}
        </div>
      )}
    </div>
  );
}

function ExpandedSidebarSections() {
  return (
    <div className="flex-1 min-h-0 -mx-2 px-2 mt-2 pt-2 flex flex-col overflow-hidden">
      <PinnedAgentListSection />
      <ChatThreadsSection />
    </div>
  );
}

function ExpandedUpgradeSection() {
  return (
    <div className="px-2">
      <SidebarUpgradeCard />
    </div>
  );
}

function ExpandedFooter() {
  const activeId = useGet(activeRoute$);
  const onSelect = useNavSelect();
  const slackScopeMismatch = useLastResolved(slackOrgScopeMismatch$) ?? false;
  const { footerNav } = useResolvedNavItems();
  return (
    <div className="p-2">
      <div className="flex flex-col gap-1">
        {footerNav.map(
          ({
            id,
            activeKeys,
            pathname: navPath,
            label,
            icon: Icon,
            iconImg,
          }) => {
            const isActive =
              activeId !== null &&
              (activeKeys as readonly RouteKey[]).includes(activeId);
            return (
              <Link
                key={id}
                pathname={navPath as Parameters<typeof Link>[0]["pathname"]}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) {
                    return;
                  }
                  e.preventDefault();
                  onSelect(id);
                }}
                className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                  isActive
                    ? "bg-gray-200 text-gray-900 font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`}
              >
                {iconImg ? (
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden">
                    <img
                      src={iconImg}
                      alt=""
                      className="h-3.5 w-3.5 scale-[2.2]"
                      width={14}
                      height={14}
                    />
                  </span>
                ) : (
                  <Icon size={16} className="shrink-0" />
                )}
                <span className="truncate flex-1">{label}</span>
                {id === "works" && slackScopeMismatch && (
                  <span
                    data-testid="slack-scope-mismatch-indicator"
                    className="h-2 w-2 shrink-0 rounded-full bg-red-500"
                  />
                )}
              </Link>
            );
          },
        )}
        <div className="h-px bg-border/30 mx-1 my-1" />
        <ExpandedFooterAccountInsights />
      </div>
    </div>
  );
}

function ExpandedFooterAccountInsights() {
  const activeId = useGet(activeRoute$);
  const onSelect = useNavSelect();
  const { t } = useTranslation();
  const insightsLabel = t(($) => {
    return $.appShell.sidebar.navigation.insightsAndUsage;
  });
  return (
    <div className="flex items-center gap-1">
      <div className="flex-1 min-w-0">
        <AccountDropdownContainer />
      </div>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              pathname="/insights"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey) {
                  return;
                }
                e.preventDefault();
                onSelect("insights");
              }}
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 ${
                activeId === "insights"
                  ? "bg-gray-200 text-gray-900"
                  : "text-sidebar-foreground hover:bg-sidebar-accent"
              }`}
              aria-label={insightsLabel}
            >
              <IconSparkles size={16} className="shrink-0" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">{insightsLabel}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

// --- Three-column (Slack-style) layout, gated behind ThreeColumnNav ---

function LabeledRailLink({
  id,
  navPath,
  label,
  icon: Icon,
  iconImg,
  isActive,
  showBadge,
  onSelect,
}: {
  id: SidebarNavId;
  navPath: string;
  label: string;
  icon: NavIcon;
  iconImg?: string | undefined;
  isActive: boolean;
  showBadge?: boolean;
  onSelect: (id: SidebarNavId) => void;
}) {
  const { t } = useTranslation();
  const caption = (() => {
    switch (id) {
      case "chat": {
        return t(($) => {
          return $.appShell.sidebar.rail.new;
        });
      }
      case "activities": {
        return t(($) => {
          return $.appShell.sidebar.rail.activity;
        });
      }
      case "workflows": {
        return t(($) => {
          return $.appShell.sidebar.rail.workflows;
        });
      }
      case "works": {
        return t(($) => {
          return $.appShell.sidebar.rail.works;
        });
      }
      default: {
        return label;
      }
    }
  })();
  return (
    <Link
      pathname={navPath as Parameters<typeof Link>[0]["pathname"]}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          return;
        }
        e.preventDefault();
        onSelect(id);
      }}
      aria-label={label}
      aria-current={isActive ? "page" : undefined}
      className="group flex w-full flex-col items-center gap-1 no-underline"
    >
      <span
        className={`relative inline-flex h-9 w-10 items-center justify-center rounded-xl transition-colors duration-200 ${
          isActive
            ? "bg-gray-200 text-gray-900"
            : "text-sidebar-foreground group-hover:bg-sidebar-accent"
        }`}
      >
        {iconImg ? (
          <span className="inline-flex h-4 w-4 items-center justify-center overflow-hidden">
            <img
              src={iconImg}
              alt=""
              className="h-4 w-4 scale-[2.2]"
              width={16}
              height={16}
            />
          </span>
        ) : (
          <Icon size={19} className="shrink-0" />
        )}
        {showBadge && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500" />
        )}
      </span>
      <span
        className={`text-[10px] leading-none ${
          isActive
            ? "font-semibold text-sidebar-foreground"
            : "text-sidebar-foreground/60"
        }`}
      >
        {caption}
      </span>
    </Link>
  );
}

function LabeledNavRail() {
  const activeId = useGet(activeRoute$);
  const slackScopeMismatch = useLastResolved(slackOrgScopeMismatch$) ?? false;
  const onSelect = useNavSelect();
  const { manageNav, footerNav } = useResolvedNavItems();
  const { t } = useTranslation();
  const navItems: {
    id: SidebarNavId;
    activeKeys: readonly RouteKey[];
    pathname: string;
    label: string;
    icon: NavIcon;
    iconImg?: string | undefined;
  }[] = [
    {
      id: "chat",
      activeKeys: ["home", "agentChat", "agentIdeas", "chat"],
      pathname: "/",
      label: t(($) => {
        return $.appShell.sidebar.navigation.newChat;
      }),
      icon: IconEdit as NavIcon,
    },
    ...manageNav,
    ...footerNav,
  ];
  return (
    <aside
      data-testid="labeled-nav-rail"
      className="zero-nav hidden md:flex h-full w-[76px] shrink-0 flex-col items-center border-r-[0.7px] border-sidebar-border bg-sidebar px-1.5 pb-2 pt-3"
    >
      <div className="zero-desktop-titlebar-drag-region" aria-hidden="true" />
      <div className="mb-3 shrink-0">
        <ZeroOrgSwitcherCompact />
      </div>
      <nav
        aria-label={t(($) => {
          return $.appShell.sidebar.ariaLabel;
        })}
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto pb-2"
      >
        {navItems.map((item) => {
          const isActive =
            activeId !== null && item.activeKeys.includes(activeId);
          return (
            <LabeledRailLink
              key={item.id}
              id={item.id}
              navPath={item.pathname}
              label={item.label}
              icon={item.icon}
              iconImg={item.iconImg}
              isActive={isActive}
              showBadge={item.id === "works" && slackScopeMismatch}
              onSelect={onSelect}
            />
          );
        })}
      </nav>
      <div className="flex w-full shrink-0 flex-col items-center gap-2 pt-1">
        <LabeledRailLink
          id="insights"
          navPath="/insights"
          label={t(($) => {
            return $.appShell.sidebar.navigation.insights;
          })}
          icon={IconSparkles as NavIcon}
          isActive={activeId === "insights"}
          onSelect={onSelect}
        />
        <AccountDropdownContainer collapsed />
      </div>
    </aside>
  );
}

function ChatListColumn() {
  const onSelect = useNavSelect();
  const openAgentList = useSet(openAgentListDialog$);
  const activeId = useGet(activeRoute$);
  const { t } = useTranslation();
  const searchLabel = t(($) => {
    return $.appShell.sidebar.searchConversations;
  });
  const newChatLabel = t(($) => {
    return $.appShell.sidebar.navigation.newChat;
  });
  const isNewChatActive =
    activeId !== null &&
    (["home", "agentChat", "agentIdeas", "chat"] as RouteKey[]).includes(
      activeId,
    );
  return (
    <aside
      data-testid="chat-list-column"
      className="zero-nav hidden md:flex h-full w-[300px] shrink-0 flex-col border-r-[0.7px] border-sidebar-border bg-sidebar"
    >
      <div className="flex shrink-0 items-center gap-1 px-3 pb-2 pt-3">
        <span className="flex-1 text-[15px] font-semibold text-sidebar-foreground">
          {t(($) => {
            return $.appShell.sidebar.chat;
          })}
        </span>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  openAgentList();
                }}
                aria-label={searchLabel}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                <IconSearch size={17} stroke={1.8} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">{searchLabel}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                pathname="/"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) {
                    return;
                  }
                  e.preventDefault();
                  onSelect("chat");
                }}
                aria-label={newChatLabel}
                aria-current={isNewChatActive ? "page" : undefined}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 no-underline transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                <IconEdit size={17} stroke={1.8} />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">{newChatLabel}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pt-1">
        <PinnedAgentListSection layout="horizontal" />
        <ChatThreadsSection />
      </div>
      <div className="px-2 pb-2">
        <SidebarUpgradeCard />
      </div>
    </aside>
  );
}

function ThreeColumnNav() {
  return (
    <>
      <LabeledNavRail />
      <ChatListColumn />
      {/* Reuse the full sidebar as the mobile drawer only. */}
      <ExpandedSidebar mobileOnly />
    </>
  );
}

export function ZeroSidebar() {
  const features = useLastResolved(featureSwitch$);
  const threeColumnNav = features?.[FeatureSwitchKey.ThreeColumnNav] ?? false;
  if (threeColumnNav) {
    return <ThreeColumnNav />;
  }
  return (
    <>
      <CollapsedSidebar />
      <ExpandedSidebar />
    </>
  );
}
