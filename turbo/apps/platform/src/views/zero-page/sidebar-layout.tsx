import type { ReactNode } from "react";
import {
  useGet,
  useSet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { IconMenu2, IconUserPlus } from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/core";
import { ZeroSidebar } from "./zero-sidebar.tsx";
import {
  currentChatAgent$,
  currentChatAgentId$,
} from "../../signals/agent-chat.ts";
import { AvatarFromUrl } from "./zero-sidebar-shared.tsx";
import { QueueDrawer } from "../queue-page/queue-drawer.tsx";
import {
  zeroShowAboutPage$,
  setZeroShowAboutPage$,
  sidebarExpanded$,
  setSidebarExpanded$,
  isChatRoute,
} from "../../signals/zero-page/zero-nav.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
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
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { OrgManageDialog } from "./components/org-manage/org-manage-dialog.tsx";

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

function MobileTopBar() {
  const navigateTo = useSet(detachedNavigateTo$);
  const setExpanded = useSet(setSidebarExpanded$);
  const agentId = useLastResolved(currentChatAgentId$);

  const breadcrumbLoadable = useLastLoadable(mobileBreadcrumb$);
  const breadcrumb =
    breadcrumbLoadable.state === "hasData" ? breadcrumbLoadable.data : null;

  const activeId = useGet(activeRoute$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin = isAdminLoadable.state === "hasData" && isAdminLoadable.data;
  const setTab = useSet(setActiveOrgManageTab$);
  const setSubPage = useSet(setBillingSubPage$);
  const openManage = useSet(setOrgManageDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const features = useLastResolved(featureSwitch$);
  const mobileChatListEnabled =
    features?.[FeatureSwitchKey.MobileChatListPage] ?? false;

  const showInvite = isChatRoute(activeId) && isAdmin;

  const handleMenuClick = () => {
    if (mobileChatListEnabled) {
      if (agentId) {
        navigateTo("/chats", {
          searchParams: new URLSearchParams({ agentId }),
        });
      } else {
        navigateTo("/chats");
      }
    } else {
      setExpanded(true);
    }
  };

  return (
    <div className="md:hidden shrink-0 flex items-center h-12 px-3 gap-2 bg-background border-b border-border/50 z-10">
      <button
        type="button"
        onClick={handleMenuClick}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        aria-label="Open menu"
      >
        <IconMenu2 size={18} stroke={1.8} />
      </button>
      {breadcrumb && (
        <div className="flex-1 min-w-0 flex items-center gap-2 min-w-0">
          {breadcrumb.avatarAgentId && <AgentAvatarInTopBar />}
          <div className="flex items-baseline gap-1 min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground flex items-center gap-1 shrink-0">
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
      {showInvite && (
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
      )}
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
