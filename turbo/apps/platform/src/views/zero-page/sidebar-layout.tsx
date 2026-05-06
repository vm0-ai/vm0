import type { ReactNode } from "react";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
  useResolved,
} from "ccstate-react";
import {
  IconArrowLeft,
  IconMenu2,
  IconPlus,
  IconSearch,
  IconUserPlus,
  IconVolume2,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { RouteKey } from "../../signals/route-paths.ts";
import { cn } from "@vm0/ui";
import { ZeroSidebar } from "./zero-sidebar.tsx";
import {
  currentChatAgent$,
  currentChatAgentId$,
  earliestUnreadEndedThread$,
} from "../../signals/agent-chat.ts";
import {
  createNewChatThreadOptimistically$,
  optimisticChatThread$,
  type OptimisticChatPane,
} from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import { AvatarFromUrl } from "./zero-sidebar-shared.tsx";
import { QueueDrawer } from "../queue-page/queue-drawer.tsx";
import {
  zeroShowAboutPage$,
  setZeroShowAboutPage$,
  sidebarExpanded$,
  setSidebarExpanded$,
  isChatRoute,
  navigateToChat$,
} from "../../signals/zero-page/zero-nav.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { activeRoute$ } from "../../signals/active-route.ts";
import { mobileBreadcrumb$ } from "../../signals/zero-page/zero-mobile-breadcrumb.ts";
import { ZeroAboutPage } from "./zero-about-page.tsx";
import { Link } from "../router/link.tsx";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { user$ } from "../../signals/auth.ts";
import {
  setMobileConnectorsSearchOpen$,
  mobileConnectorsSearchOpen$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { setJobsDialogOpen$ } from "../../signals/zero-page/zero-jobs-page.ts";
import { openCreateScheduleDialog$ } from "../../signals/schedule-page/schedule-page-ui.ts";
import {
  connectorsPageTab$,
  openCustomConnectorCreateDialog$,
} from "../../signals/zero-page/settings/custom-connectors.ts";
import {
  setActiveOrgManageTab$,
  setBillingSubPage$,
} from "../../signals/zero-page/settings/org-manage-tabs-state.ts";
import {
  orgManageDialogOpen$,
  setOrgManageDialogOpen$,
} from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  autoReadEnabled$,
  toggleAutoRead$,
} from "../../signals/voice-io/voice-io-settings.ts";
import { OrgManageDialog } from "./components/org-manage/org-manage-dialog.tsx";
import {
  InstallBanner,
  IosInstallModal,
} from "../pwa-install/install-banner.tsx";
import { MobileBottomTabBar } from "./mobile-bottom-tab-bar.tsx";
import { MobileMoreSheet } from "./mobile-more-sheet.tsx";
import { MobileNewSessionSheet } from "./mobile-new-session-sheet.tsx";
import { MobileWorkspaceDrawer } from "./mobile-workspace-drawer.tsx";

// Glass treatment for top-bar tap targets when MobileNativeV1 is on. Bar
// surface stays transparent — only interactive elements lift, with the same
// `bg-card/70 backdrop-blur-xl` recipe the bottom dock uses, plus a 1px
// shadow that's intentionally weaker than the dock's so the top reads quieter.
// All glass tap targets share the same frame, hover, and shadow so the
// workspace pill, search button, and avatar feel like siblings.
const TOPBAR_GLASS =
  "bg-card/70 backdrop-blur-xl border border-border/60 shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:bg-card hover:shadow-[0_2px_6px_rgb(0_0_0/0.06)] transition-all";

function AgentAvatarInTopBar() {
  const agent = useLastResolved(currentChatAgent$);
  if (!agent) {
    return (
      <div className="h-6 w-6 shrink-0 rounded-full bg-muted" aria-hidden />
    );
  }
  return (
    <AvatarFromUrl
      avatarUrl={agent.avatarUrl}
      alt=""
      className="h-6 w-6 shrink-0 rounded-full object-cover object-top"
      data-testid="agent-avatar"
    />
  );
}

function AutoReadToggleLeaf() {
  const autoRead = useGet(autoReadEnabled$);
  const toggleAutoReadFn = useSet(toggleAutoRead$);
  return (
    <button
      type="button"
      onClick={() => {
        toggleAutoReadFn();
      }}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
        autoRead
          ? "text-primary bg-primary/10"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
      )}
      aria-label="Toggle auto-read"
    >
      <IconVolume2 size={16} stroke={1.5} />
    </button>
  );
}

function InviteButtonLeaf() {
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin = isAdminLoadable.state === "hasData" && isAdminLoadable.data;
  const setTab = useSet(setActiveOrgManageTab$);
  const setSubPage = useSet(setBillingSubPage$);
  const openManage = useSet(setOrgManageDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  if (!isAdmin) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={() => {
        setTab("members");
        setSubPage(false);
        detach(openManage(true, pageSignal), Reason.DomCallback);
      }}
      className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
    >
      <IconUserPlus size={14} stroke={1.5} />
      Invite
    </button>
  );
}

function NewOrUnreadChatButtonLeaf() {
  const currentChatAgentId = useResolved(currentChatAgentId$);
  const createNewChat = useSet(createNewChatThreadOptimistically$);
  const navigateToChatFn = useSet(navigateToChat$);
  const rootSignal = useGet(rootSignal$);
  const creating = useGet(optimisticChatThread$) !== null;
  const unreadThread = useLastResolved(earliestUnreadEndedThread$);

  if (unreadThread) {
    return (
      <button
        type="button"
        onClick={() => {
          navigateToChatFn(unreadThread.id);
        }}
        className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
      >
        <span
          className="shrink-0 h-2 w-2 rounded-full bg-primary"
          aria-label="Unread"
        />
        unread
      </button>
    );
  }

  const handleNewChat = (pane: OptimisticChatPane) => {
    detach(
      createNewChat(currentChatAgentId ?? null, pane, rootSignal),
      Reason.DomCallback,
    );
  };

  return (
    <button
      type="button"
      onClick={(event) => {
        handleNewChat(event.altKey ? "sidebar" : "main");
      }}
      disabled={creating}
      className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0 disabled:opacity-50"
    >
      <IconPlus size={14} stroke={1.5} />
      New
    </button>
  );
}

function MobileTopBarActions({
  activeId,
  mobileNativeOn,
}: {
  activeId: RouteKey | null;
  mobileNativeOn: boolean;
}) {
  const inChatRoute = isChatRoute(activeId);
  const features = useLastResolved(featureSwitch$);
  const newButtonEnabled =
    features?.[FeatureSwitchKey.ChatHeaderNewButton] ?? false;
  const audioOutputEnabled = features?.[FeatureSwitchKey.AudioOutput] ?? false;

  if (mobileNativeOn) {
    return <MobileTopBarPageActions activeId={activeId} />;
  }
  return (
    <>
      {inChatRoute && audioOutputEnabled && <AutoReadToggleLeaf />}
      {inChatRoute &&
        (newButtonEnabled ? (
          <NewOrUnreadChatButtonLeaf />
        ) : (
          <InviteButtonLeaf />
        ))}
    </>
  );
}

function ChatListHeaderSearchLink() {
  return (
    <Link
      pathname="/search"
      aria-label="Search chats"
      data-testid="mobile-chat-list-search-toggle"
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground no-underline",
        TOPBAR_GLASS,
      )}
    >
      <IconSearch size={16} stroke={1.6} />
    </Link>
  );
}

function ConnectorsHeaderSearchToggle() {
  const open = useGet(mobileConnectorsSearchOpen$);
  const setOpen = useSet(setMobileConnectorsSearchOpen$);
  return (
    <button
      type="button"
      onClick={() => {
        setOpen(!open);
      }}
      aria-pressed={open}
      aria-label="Search connectors"
      data-testid="mobile-connectors-search-toggle"
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
        TOPBAR_GLASS,
        open
          ? "text-foreground bg-card"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <IconSearch size={16} stroke={1.6} />
    </button>
  );
}

function HeaderAccountAvatar() {
  const userLoadable = useLastLoadable(user$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : null;
  const name = user?.fullName ?? "Account";
  const initial = name.charAt(0).toUpperCase();
  const imageUrl = user?.imageUrl;
  return (
    <Link
      pathname="/account"
      aria-label="Open account"
      data-testid="mobile-header-account"
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full overflow-hidden no-underline",
        TOPBAR_GLASS,
      )}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center bg-[hsl(var(--gray-200))] text-xs font-semibold text-[hsl(var(--primary-700))]">
          {initial}
        </span>
      )}
    </Link>
  );
}

function HeaderIconButton({
  label,
  testId,
  onClick,
  disabled,
}: {
  label: string;
  testId: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      data-testid={testId}
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-50",
        TOPBAR_GLASS,
      )}
    >
      <IconPlus size={18} stroke={1.8} />
    </button>
  );
}

function NewAgentHeaderButton() {
  const setOpen = useSet(setJobsDialogOpen$);
  return (
    <HeaderIconButton
      label="New agent"
      testId="mobile-new-agent"
      onClick={() => {
        setOpen(true);
      }}
    />
  );
}

function NewScheduleHeaderButton() {
  const openDialog = useSet(openCreateScheduleDialog$);
  const pageSignal = useGet(pageSignal$);
  return (
    <HeaderIconButton
      label="New schedule"
      testId="mobile-new-schedule"
      onClick={() => {
        detach(openDialog(pageSignal), Reason.DomCallback);
      }}
    />
  );
}

function NewCustomConnectorHeaderButton() {
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin = isAdminLoadable.state === "hasData" && isAdminLoadable.data;
  const tab = useGet(connectorsPageTab$);
  const openDialog = useSet(openCustomConnectorCreateDialog$);
  if (!isAdmin || tab !== "custom") {
    return null;
  }
  return (
    <HeaderIconButton
      label="New connector"
      testId="mobile-new-connector"
      onClick={() => {
        openDialog();
      }}
    />
  );
}

// Per-route action cluster on the right of the mobile top bar. Account avatar
// only appears on the chat-list (Home) tab; per-page primary actions live in
// the same slot so each surface has at most one or two icons + the avatar.
function MobileTopBarPageActions({
  activeId,
}: {
  activeId: RouteKey | null;
}) {
  if (activeId === "chatList") {
    return (
      <>
        <ChatListHeaderSearchLink />
        <HeaderAccountAvatar />
      </>
    );
  }
  if (activeId === "agents") {
    return <NewAgentHeaderButton />;
  }
  if (activeId === "schedules") {
    return <NewScheduleHeaderButton />;
  }
  if (activeId === "connectors") {
    return (
      <>
        <ConnectorsHeaderSearchToggle />
        <NewCustomConnectorHeaderButton />
      </>
    );
  }
  return null;
}

// Resolves a centered page title for the mobile top bar from the active route.
// Chat routes are excluded — they keep their breadcrumb-style agent label.
function mobileTopBarTitle(route: RouteKey | null): string | undefined {
  switch (route) {
    case "chatList": {
      return "Home";
    }
    case "agents": {
      return "Agents";
    }
    case "schedules": {
      return "Scheduled";
    }
    case "connectors": {
      return "Connectors";
    }
    case "insights": {
      return "Insights";
    }
    case "works": {
      return "Slack & Telegram";
    }
    case "account": {
      return "Account";
    }
    case "settings": {
      return "Preferences";
    }
    case "settingsApiKeys": {
      return "API Keys";
    }
    case "usage": {
      return "Usage";
    }
    case "activities": {
      return "Activity logs";
    }
    case "lab": {
      return "Lab";
    }
    default: {
      return undefined;
    }
  }
}

function BackButton({
  pathname,
  label,
  testId,
}: {
  pathname: "/chats" | "/account" | "/agents" | "/schedules";
  label: string;
  testId: string;
}) {
  return (
    <Link
      pathname={pathname}
      aria-label={label}
      data-testid={testId}
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground no-underline",
        TOPBAR_GLASS,
      )}
    >
      <IconArrowLeft size={18} stroke={1.8} />
    </Link>
  );
}

// Routes that live under the Account hub (entered from /account) and need a
// back arrow to return there instead of being orphan pages on mobile.
function isAccountSubRoute(route: RouteKey | null): boolean {
  return (
    route === "settings" ||
    route === "usage" ||
    route === "settingsApiKeys"
  );
}

function HamburgerButton() {
  const setExpanded = useSet(setSidebarExpanded$);
  return (
    <button
      type="button"
      onClick={() => {
        setExpanded(true);
      }}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
      aria-label="Open menu"
    >
      <IconMenu2 size={18} stroke={1.8} />
    </button>
  );
}

// Resolves which control to surface in the mobile top bar's left slot:
// the workspace pill on the Home (chat list) tab, the back arrow inside a
// thread, or nothing on other index pages so the centered title is uncluttered.
// Falls back to the hamburger when the mobile redesign is off.
function MobileTopBarLeftSlot({
  activeId,
  mobileNativeOn,
}: {
  activeId: RouteKey | null;
  mobileNativeOn: boolean;
}) {
  if (!mobileNativeOn) {
    return <HamburgerButton />;
  }
  if (activeId === "chatList") {
    return <MobileWorkspaceDrawer />;
  }
  if (activeId === "chat") {
    return (
      <BackButton
        pathname="/chats"
        label="Back to chat list"
        testId="mobile-back-to-chat-list"
      />
    );
  }
  if (
    activeId === "agentDetail" ||
    activeId === "agentPermissions"
  ) {
    return (
      <BackButton
        pathname="/agents"
        label="Back to agents"
        testId="mobile-back-to-agents"
      />
    );
  }
  if (activeId === "scheduleDetail") {
    return (
      <BackButton
        pathname="/schedules"
        label="Back to schedules"
        testId="mobile-back-to-schedules"
      />
    );
  }
  if (isAccountSubRoute(activeId)) {
    return (
      <BackButton
        pathname="/account"
        label="Back to account"
        testId="mobile-back-to-account"
      />
    );
  }
  return null;
}

// Resolve which surface (breadcrumb / centered title / nothing) the mobile
// top bar should show alongside the route-specific left slot.
function resolveTopBarSurface(
  activeId: RouteKey | null,
  breadcrumb: { name?: string } | null,
  mobileNativeOn: boolean,
): { showBreadcrumb: boolean; centeredTitle: string | undefined } {
  const isChatPage = isChatRoute(activeId);
  // Detail pages that render as "back arrow + name title" instead of a
  // breadcrumb. The agent / schedule name is more useful as the title than
  // the section repeating what the back arrow already conveys.
  const isBackTitleRoute =
    activeId === "agentDetail" ||
    activeId === "agentPermissions" ||
    activeId === "scheduleDetail";
  const hasDetailName = breadcrumb?.name !== undefined;
  const showBreadcrumb =
    breadcrumb !== null &&
    (!mobileNativeOn || isChatPage || (hasDetailName && !isBackTitleRoute));
  if (mobileNativeOn && isBackTitleRoute && breadcrumb?.name) {
    return { showBreadcrumb: false, centeredTitle: breadcrumb.name };
  }
  const fallbackTitle =
    mobileNativeOn && !showBreadcrumb ? mobileTopBarTitle(activeId) : undefined;
  return { showBreadcrumb, centeredTitle: fallbackTitle };
}

function MobileTopBar() {
  const breadcrumbLoadable = useLastLoadable(mobileBreadcrumb$);
  const breadcrumb =
    breadcrumbLoadable.state === "hasData" ? breadcrumbLoadable.data : null;

  const activeId = useGet(activeRoute$);

  // When the mobile redesign is on, the bottom tab bar's "More" tab opens
  // the same sidebar overlay as the hamburger, so the top-bar hamburger is
  // redundant. The left slot becomes route-specific (see MobileTopBarLeftSlot).
  const features = useLastResolved(featureSwitch$);
  const mobileNativeOn = features?.[FeatureSwitchKey.MobileNativeV1] ?? false;

  const { showBreadcrumb, centeredTitle } = resolveTopBarSurface(
    activeId,
    breadcrumb,
    mobileNativeOn,
  );

  return (
    <div
      className={cn(
        "md:hidden shrink-0 relative flex items-center px-3 gap-2 z-10",
        mobileNativeOn
          ? "min-h-14 py-1.5"
          : "min-h-12 bg-background border-b border-border/50",
      )}
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <MobileTopBarLeftSlot
        activeId={activeId}
        mobileNativeOn={mobileNativeOn}
      />
      {showBreadcrumb && breadcrumb && (
        <div
          className="flex-1 min-w-0 flex items-center gap-2 min-w-0"
          data-testid="mobile-breadcrumb"
        >
          {breadcrumb.avatarAgentId && <AgentAvatarInTopBar />}
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm font-medium text-foreground flex items-center gap-1 min-w-0">
              <Link
                pathname={breadcrumb.sectionPath}
                className="hover:opacity-70 transition-opacity no-underline text-inherit"
              >
                {breadcrumb.section}
              </Link>
              {breadcrumb.name && (
                <>
                  <span className="text-foreground/30 select-none">/</span>
                  <span className="truncate" data-testid="breadcrumb-name">
                    {breadcrumb.name}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {!showBreadcrumb && <div className="flex-1" />}
      {centeredTitle && (
        <h1
          data-testid="mobile-top-bar-title"
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-sm font-semibold text-foreground truncate max-w-[55%]"
        >
          {centeredTitle}
        </h1>
      )}
      <MobileTopBarActions
        activeId={activeId}
        mobileNativeOn={mobileNativeOn}
      />
    </div>
  );
}

function OrgManageDialogMount() {
  const dialogOpen = useGet(orgManageDialogOpen$);
  const setDialogOpen = useSet(setOrgManageDialogOpen$);
  const pageSignal = useGet(pageSignal$);

  return (
    <OrgManageDialog
      open={dialogOpen}
      onOpenChange={(open) => {
        detach(setDialogOpen(open, pageSignal), Reason.DomCallback);
      }}
    />
  );
}

function SidebarLayoutInner({ children }: { children: ReactNode }) {
  const showAboutPage = useGet(zeroShowAboutPage$);
  const setShowAboutPage = useSet(setZeroShowAboutPage$);
  const expanded = useGet(sidebarExpanded$);
  const setExpanded = useSet(setSidebarExpanded$);

  return (
    <div className="zero-app flex h-dvh w-full bg-background">
      <OrgManageDialogMount />
      <QueueDrawer />
      <ZeroSidebar />
      <div
        data-sidebar-expanded={expanded || undefined}
        className="fixed inset-0 z-30 bg-black/40 hidden data-[sidebar-expanded]:max-md:block"
        aria-label="Sidebar overlay"
        onClick={() => {
          return setExpanded(false);
        }}
      />
      <div className="flex flex-1 flex-col min-w-0 min-h-0 zero-workspace-bg">
        <InstallBanner />
        <IosInstallModal />
        <MobileTopBar />
        {showAboutPage ? (
          <ZeroAboutPage
            onBack={() => {
              return setShowAboutPage(false);
            }}
          />
        ) : (
          children
        )}
        <MobileBottomTabBar />
      </div>
      <MobileMoreSheet />
      <MobileNewSessionSheet />
    </div>
  );
}

export function SidebarLayout({ children }: { children: ReactNode }) {
  return <SidebarLayoutInner>{children}</SidebarLayoutInner>;
}
