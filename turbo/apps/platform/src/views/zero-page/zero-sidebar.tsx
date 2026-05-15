// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import {
  useLastLoadable,
  useLastResolved,
  useGet,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconChartLine,
  IconLayoutGrid,
  IconCalendar,
  IconUsers,
  IconEdit,
  IconChevronRight,
  IconLayoutSidebarLeftCollapse,
  IconPlug,
  IconSparkles,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import slackIcon from "./components/settings/icons/slack.svg";
import { detach, Reason } from "../../signals/utils.ts";
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
import { subagents$, defaultAgentName$ } from "../../signals/agent.ts";
import { currentChatAgentId$ } from "../../signals/agent-chat.ts";
import { updatePinnedAgentIds$ } from "../../signals/zero-page/zero-pinned-agents.ts";
import {
  managePinnedDialogOpen$,
  setManagePinnedDialogOpen$,
  isScrolled$,
  setIsScrolled$,
  manageSectionCollapsed$,
  setManageSectionCollapsed$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { ZeroOrgSwitcher } from "./zero-org-switcher.tsx";
import { Link } from "../router/link.tsx";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { slackOrgScopeMismatch$ } from "../../signals/zero-page/zero-slack.ts";
import { BillingDialog } from "./billing-dialog.tsx";
import { ManagePinnedAgentsDialog } from "./zero-sidebar-dialogs.tsx";

import { AccountDropdown } from "./zero-sidebar-account.tsx";
import { ChatThreadsSection } from "./sidebar-threads.tsx";
import { PinnedAgentListSection } from "./zero-sidebar-pinned.tsx";
import { OverlayScrollArea } from "./zero-sidebar-scroll.tsx";
import { SidebarUpgradeCard } from "./zero-sidebar-upgrade.tsx";

export { AccountDropdown } from "./zero-sidebar-account.tsx";

type NavIcon = (props: { size?: number; className?: string }) => ReactNode;

interface ManageNavItem {
  readonly id: SidebarNavId;
  readonly activeKeys: readonly RouteKey[];
  readonly pathname: string;
  readonly label: string;
  readonly icon: NavIcon;
}

const MANAGE_NAV = [
  {
    id: "agents",
    activeKeys: ["agents", "agentDetail", "agentPermissions"],
    pathname: "/agents",
    label: "Agents",
    icon: IconUsers as NavIcon,
  },
  {
    id: "connectors",
    activeKeys: ["connectors"],
    pathname: "/connectors",
    label: "Connectors",
    icon: IconPlug as NavIcon,
  },
  {
    id: "schedules",
    activeKeys: ["schedules", "scheduleDetail"],
    pathname: "/schedules",
    label: "Scheduled",
    icon: IconCalendar as NavIcon,
  },
  {
    id: "activities",
    activeKeys: ["activities", "activityDetail"],
    pathname: "/activities",
    label: "Activity logs",
    icon: IconChartLine as NavIcon,
  },
] as const satisfies readonly ManageNavItem[];

interface FooterNavItem {
  readonly id: SidebarNavId;
  readonly activeKeys: readonly RouteKey[];
  readonly pathname: string;
  readonly label: string;
  readonly icon: NavIcon;
  readonly iconImg: string | undefined;
}

const FOOTER_NAV = [
  {
    id: "works",
    activeKeys: ["works"],
    pathname: "/works",
    label: "Where Zero works",
    icon: IconLayoutGrid as NavIcon,
    iconImg: slackIcon,
  },
] as const satisfies readonly FooterNavItem[];

// Leaf component: subscribes to currentChatAgentId$ so ZeroSidebar doesn't re-render on agent changes.
// useLastResolved keeps the previously-resolved agent ID during re-loads, preventing unnecessary
// remounts of ChatThreadsSection that would cause the chat list to flash.
function ChatThreadsSectionWithKey() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  return <ChatThreadsSection key={currentChatAgentId} />;
}

// Leaf component: owns all dialog-related async subscriptions
function ManagePinnedAgentsDialogContainer() {
  const open = useGet(managePinnedDialogOpen$);
  const setOpen = useSet(setManagePinnedDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const displayNameLoadable = useLastLoadable(defaultAgentName$);
  const displayName =
    displayNameLoadable.state === "hasData"
      ? (displayNameLoadable.data ?? "Zero")
      : "Zero";
  const subagentsLoadable = useLastLoadable(subagents$);
  const subagentsData =
    subagentsLoadable.state === "hasData" ? subagentsLoadable.data : [];
  const [pinLoadable, savePinnedIdsFn] = useLoadableSet(updatePinnedAgentIds$);
  const saving = pinLoadable.state === "loading";
  const setPinnedIds = (ids: string[]) => {
    detach(savePinnedIdsFn(ids, pageSignal), Reason.DomCallback);
  };
  return (
    <ManagePinnedAgentsDialog
      open={open}
      onOpenChange={setOpen}
      displayName={displayName}
      subagents={subagentsData}
      onPinnedIdsChange={setPinnedIds}
      saving={saving}
    />
  );
}

// Nav content for both sidebars: subscribes to feature flags, default agent name, slack scope
function SidebarNavContent() {
  const activeId = useGet(activeRoute$);
  const off = useGet(sidebarOff$);
  const toggleOff = useSet(toggleSidebarOff$);
  const expanded = useGet(sidebarExpanded$);
  const setExpanded = useSet(setSidebarExpanded$);
  const onCollapse = () => {
    setExpanded(false);
    return toggleOff();
  };
  const rawOnSelect = useSet(handleZeroNavSelect$);
  const onAccountAction = useSet(handleZeroAccountAction$);
  const pageSignal = useGet(pageSignal$);
  const onSelect = (id: SidebarNavId) => {
    rawOnSelect(id, pageSignal);
    setExpanded(false);
  };
  const isScrolled = useGet(isScrolled$);
  const setIsScrolledFn = useSet(setIsScrolled$);
  const manageCollapsed = useGet(manageSectionCollapsed$);
  const setManageCollapsed = useSet(setManageSectionCollapsed$);

  const features = useLastResolved(featureSwitch$);
  const defaultDisplayName = useLastResolved(defaultAgentName$) ?? "Zero";
  const slackScopeMismatch = useLastResolved(slackOrgScopeMismatch$) ?? false;

  const manageNav = MANAGE_NAV.filter((item) => {
    return item.id !== "activities" || features?.[FeatureSwitchKey.ZeroDebug];
  });
  const footerNav = FOOTER_NAV.map((item) => {
    return {
      ...item,
      label: item.label.replace("Zero", defaultDisplayName),
    };
  });

  const allNavItems = [
    ...manageNav.map(({ id, activeKeys, pathname: p, label, icon }) => {
      return { id, activeKeys, pathname: p, label, icon };
    }),
    {
      id: "chat" as const,
      activeKeys: ["home", "agentChat", "agentIdeas", "chat"] as RouteKey[],
      pathname: "/",
      label: "New chat",
      icon: IconEdit as NavIcon,
    },
    ...footerNav.map(({ id, activeKeys, pathname: p, label, icon }) => {
      return { id, activeKeys, pathname: p, label, icon };
    }),
  ];

  return (
    <>
      {/* Collapsed icon-only sidebar — desktop only, only rendered when sidebarOff */}
      {off && (
        <aside className="zero-nav box-border hidden md:flex h-full w-16 shrink-0 flex-col border-r-[0.7px] border-sidebar-border bg-sidebar px-2 transition-all duration-300">
          <div className="flex w-full shrink-0 justify-center pt-3 pb-1">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-[hsl(var(--gray-200))] hover:text-sidebar-foreground"
                    onClick={onCollapse}
                    aria-label="Expand sidebar"
                  >
                    <IconLayoutSidebarLeftCollapse
                      size={18}
                      className="rotate-180"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p className="text-xs">Expand sidebar</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          <nav className="flex min-h-0 w-full min-w-0 flex-1 flex-col items-center gap-1 pb-2 pt-0">
            <TooltipProvider delayDuration={100}>
              {allNavItems.map(
                ({ id, activeKeys, pathname: navPath, label, icon: Icon }) => {
                  const isActive =
                    activeId !== null &&
                    (activeKeys as readonly RouteKey[]).includes(activeId);
                  return (
                    <div
                      key={id}
                      className="flex w-full shrink-0 justify-center"
                    >
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
                              if (id === "chat") {
                                onSelect("chat");
                              } else {
                                onSelect(id);
                              }
                            }}
                            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 ${
                              isActive
                                ? "bg-gray-200 text-gray-900"
                                : "text-sidebar-foreground hover:bg-sidebar-accent"
                            }`}
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
                  >
                    <IconSparkles size={16} className="shrink-0" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p className="text-xs">Insights &amp; Usage</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <AccountDropdown onAccountAction={onAccountAction} collapsed />
          </div>
        </aside>
      )}

      {/* Expanded full sidebar — desktop default, mobile overlay when expanded */}
      <aside
        data-sidebar-off={off || undefined}
        data-sidebar-expanded={expanded || undefined}
        className="zero-nav hidden md:flex data-[sidebar-off]:md:hidden data-[sidebar-expanded]:max-md:flex h-full w-[300px] shrink-0 flex-col border-r-[0.7px] border-sidebar-border bg-sidebar transition-all duration-300 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-xl"
      >
        {/* Organization switcher */}
        <div
          className="shrink-0 px-2 pb-0"
          style={{ paddingTop: "calc(0.375rem + var(--sat))" }}
        >
          <div className="flex items-center justify-between gap-2 rounded-lg py-0.5">
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
                    aria-label="Collapse sidebar"
                  >
                    <IconLayoutSidebarLeftCollapse size={18} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Collapse sidebar</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>

        <nav
          aria-label="Sidebar"
          className="flex-1 flex flex-col min-h-0 overflow-hidden p-2 pt-1"
        >
          {/* Manage section */}
          <div className="shrink-0">
            <div
              className="group flex h-8 shrink-0 cursor-pointer items-center justify-between rounded-lg pl-2 pr-0 hover:bg-sidebar-accent transition-colors"
              onClick={() => {
                return setManageCollapsed(!manageCollapsed);
              }}
            >
              <span className="flex flex-1 items-center gap-1 truncate text-[13px] font-medium leading-4 text-sidebar-foreground/50 group-hover:text-sidebar-foreground transition-colors">
                Manage
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
                  ({
                    id,
                    activeKeys,
                    pathname: navPath,
                    label,
                    icon: Icon,
                  }) => {
                    const isActive =
                      activeId !== null &&
                      (activeKeys as readonly RouteKey[]).includes(activeId);
                    return (
                      <Link
                        key={id}
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

          {/* Scrollable: Pinned + Recent chats */}
          <OverlayScrollArea
            className="flex-1 min-h-0 -mx-2 px-2 mt-2 pt-2"
            data-testid="sidebar-scroll-area"
            onScroll={(e) => {
              return setIsScrolledFn(e.currentTarget.scrollTop > 0);
            }}
            style={{
              boxShadow: isScrolled
                ? "0 -1px 0 0 hsl(var(--border) / 0.4)"
                : "none",
            }}
          >
            <PinnedAgentListSection />
            <ChatThreadsSectionWithKey />
          </OverlayScrollArea>
        </nav>

        {/* Upgrade card */}
        <div className="px-2">
          <SidebarUpgradeCard />
        </div>

        {/* Footer nav */}
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
            {/* Insights + Account */}
            <div className="flex items-center gap-1">
              <div className="flex-1 min-w-0">
                <AccountDropdown onAccountAction={onAccountAction} />
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
                    >
                      <IconSparkles size={16} className="shrink-0" />
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <p className="text-xs">Insights &amp; Usage</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

export function ZeroSidebar() {
  return (
    <>
      <SidebarNavContent />
      <ManagePinnedAgentsDialogContainer />
      <BillingDialog />
    </>
  );
}
