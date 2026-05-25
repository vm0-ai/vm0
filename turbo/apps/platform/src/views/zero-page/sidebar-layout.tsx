import type { ReactNode } from "react";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
  useResolved,
} from "ccstate-react";
import {
  IconMenu2,
  IconPlus,
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
import {
  setActiveOrgManageTab$,
  setBillingSubPage$,
} from "../../signals/zero-page/settings/org-manage-tabs-state.ts";
import {
  orgManageDialogOpen$,
  setOrgManageDialogOpen$,
} from "../../signals/zero-page/settings/org-manage-dialog.ts";
import {
  settingsDialogOpen$,
  setSettingsDialogOpen$,
} from "../../signals/zero-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  autoReadEnabled$,
  toggleAutoRead$,
} from "../../signals/voice-io/voice-io-settings.ts";
import { OrgManageDialog } from "./components/org-manage/org-manage-dialog.tsx";
import { SettingsDialog } from "./components/settings/settings-dialog.tsx";
import {
  InstallBanner,
  IosInstallModal,
} from "../pwa-install/install-banner.tsx";

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
    if (!currentChatAgentId) {
      return;
    }
    detach(
      createNewChat(currentChatAgentId, pane, rootSignal),
      Reason.DomCallback,
    );
  };

  return (
    <button
      type="button"
      onClick={(event) => {
        handleNewChat(event.altKey ? "sidebar" : "main");
      }}
      disabled={!currentChatAgentId || creating}
      className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0 disabled:opacity-50"
    >
      <IconPlus size={14} stroke={1.5} />
      New
    </button>
  );
}

function MobileTopBarActions({ activeId }: { activeId: RouteKey | null }) {
  const inChatRoute = isChatRoute(activeId);
  const features = useLastResolved(featureSwitch$);
  const newButtonEnabled =
    features?.[FeatureSwitchKey.ChatHeaderNewButton] ?? false;
  const audioOutputEnabled = features?.[FeatureSwitchKey.AudioOutput] ?? false;
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

function MobileTopBar() {
  const setExpanded = useSet(setSidebarExpanded$);

  const breadcrumbLoadable = useLastLoadable(mobileBreadcrumb$);
  const breadcrumb =
    breadcrumbLoadable.state === "hasData" ? breadcrumbLoadable.data : null;

  const activeId = useGet(activeRoute$);

  return (
    <div
      className="md:hidden shrink-0 flex items-center min-h-12 px-3 gap-2 bg-background border-b border-border/50 z-10"
      style={{ paddingTop: "var(--sat)" }}
    >
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
      {breadcrumb && (
        <div className="flex-1 min-w-0 flex items-center gap-2 min-w-0">
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
      {!breadcrumb && <div className="flex-1" />}
      <MobileTopBarActions activeId={activeId} />
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

function SettingsDialogMount() {
  const dialogOpen = useGet(settingsDialogOpen$);
  const setDialogOpen = useSet(setSettingsDialogOpen$);
  const pageSignal = useGet(pageSignal$);

  return (
    <SettingsDialog
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
      <SettingsDialogMount />
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
      </div>
    </div>
  );
}

export function SidebarLayout({ children }: { children: ReactNode }) {
  return <SidebarLayoutInner>{children}</SidebarLayoutInner>;
}
