import type { ReactNode } from "react";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Menu, Package, Share2, UserPlus } from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { RouteKey } from "../../signals/route-paths.ts";
import { Button, cn, useMediaQuery } from "@okouai/ui";
import { Sidebar } from "./sidebar.tsx";
import { AutomationMenuButton } from "./chat-thread-page.tsx";
import { currentChatAgent$ } from "../../signals/agent-chat.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "../../signals/chat-page/chat-thread-panes.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { AvatarFromUrl } from "./sidebar-shared.tsx";
import { QueueDrawer } from "../queue-page/queue-drawer.tsx";
import {
  sidebarExpanded$,
  setSidebarExpanded$,
  isChatRoute,
} from "../../signals/okou-page/nav.ts";
import { activeRoute$ } from "../../signals/active-route.ts";
import { mobileBreadcrumb$ } from "../../signals/okou-page/mobile-breadcrumb.ts";
import { Link } from "../router/link.tsx";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  closeSettingsModal$,
  openSettingsDialogAt$,
  settingsDialogOpen$,
} from "../../signals/okou-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { SettingsDialog } from "./components/settings/settings-dialog.tsx";
import {
  InstallBanner,
  IosInstallModal,
} from "../pwa-install/install-banner.tsx";
import { useOpenThreadArtifacts } from "./thread-sidebar.tsx";
import { ChatShortcutHelpDialog } from "./chat-shortcut-help-dialog.tsx";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { ConcurrencyConfirmDialog } from "./components/org-manage/org-billing-tab.tsx";
import { CreditPurchaseConfirmDialog } from "./components/org-manage/credit-purchase-confirm-dialog.tsx";
import { SubscriptionPurchaseConfirmDialog } from "./components/org-manage/subscription-purchase-confirm-dialog.tsx";
import { lightboxUrl$ } from "../../signals/okou-page/attachment-chips.ts";
import { AttachmentLightbox } from "./attachment-chips.tsx";
import {
  applyColorThemeDocumentAttributes,
  applyTypefaceDocumentAttribute,
  colorTheme$,
} from "../../signals/theme.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "./sidebar-breakpoint.ts";

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

function InviteButtonLeaf() {
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin = isAdminLoadable.state === "hasData" && isAdminLoadable.data;
  const openSettings = useSet(openSettingsDialogAt$);
  const pageSignal = useGet(pageSignal$);
  const { t } = useTranslation();
  if (!isAdmin) {
    return null;
  }
  return (
    <Button
      type="button"
      onClick={() => {
        detach(openSettings("people", pageSignal), Reason.DomCallback);
      }}
      variant="quiet"
      size="sm"
      className="shrink-0 gap-1.5"
    >
      <UserPlus size={14} />
      {t(($) => {
        return $.appShell.sidebar.mobile.invite;
      })}
    </Button>
  );
}

function MobileArtifactsButtonInner({ thread }: { thread: ChatPanelSignals }) {
  const sidebarTarget = useGet(thread.sidebar.target$);
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
  const openThreadArtifacts = useOpenThreadArtifacts(thread);
  const { t } = useTranslation();
  const open = sidebarTarget?.type === "artifacts";

  return (
    <Button
      showTooltip
      type="button"
      onClick={() => {
        reloadArtifacts();
        openThreadArtifacts();
      }}
      variant="quiet"
      size="icon-sm"
      className={cn(
        "shrink-0",
        open && "bg-primary/10 text-primary hover:text-primary",
      )}
      aria-label={t(($) => {
        return $.appShell.sidebar.mobile.openArtifacts;
      })}
      aria-pressed={open}
    >
      <Package size={16} />
    </Button>
  );
}

function MobileArtifactsButtonLeaf() {
  const leftThread = useGet(currentLeftThread$);
  const rightThread = useGet(currentRightThread$);
  const thread = leftThread ?? rightThread;

  if (!thread) {
    return null;
  }

  return <MobileArtifactsButtonInner thread={thread} />;
}

function MobileAutomationButtonLeaf() {
  const leftThread = useGet(currentLeftThread$);
  const rightThread = useGet(currentRightThread$);
  const { t } = useTranslation();
  const thread = leftThread ?? rightThread;

  if (!thread) {
    return null;
  }

  return (
    <AutomationMenuButton
      thread={thread}
      ariaLabel={t(($) => {
        return $.appShell.sidebar.mobile.openAutomations;
      })}
    />
  );
}

function MobileShareButtonInner({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const phase = useGet(thread.sharing.phase$);
  const start = useSet(thread.sharing.start$);
  const pageSignal = useGet(pageSignal$);
  const enabled =
    useGet(featureSwitch$)[FeatureSwitchKey.SharedThreadSharing] ?? false;
  if (!enabled || phase !== "idle") {
    return null;
  }
  return (
    <Button
      showTooltip
      type="button"
      onClick={() => {
        detach(
          start(pageSignal),
          Reason.DomCallback,
          "start shared thread selection",
        );
      }}
      variant="quiet"
      size="icon-sm"
      className="shrink-0"
      aria-label={t(($) => {
        return $.chat.sharing.start;
      })}
    >
      <Share2 size={16} />
    </Button>
  );
}

function MobileShareButtonLeaf() {
  const leftThread = useGet(currentLeftThread$);
  const rightThread = useGet(currentRightThread$);
  const thread = leftThread ?? rightThread;
  return thread ? <MobileShareButtonInner thread={thread} /> : null;
}

function MobileSharingOverlayInner({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const phase = useGet(thread.sharing.phase$);
  const selectedCount = useGet(thread.sharing.selectedCount$);
  const close = useSet(thread.sharing.close$);
  const pageSignal = useGet(pageSignal$);
  if (phase === "idle") {
    return null;
  }
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-between bg-background px-4">
      <span className="text-sm font-medium text-foreground">
        {t(
          ($) => {
            return $.chat.sharing.selectedCount;
          },
          { count: selectedCount },
        )}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          detach(
            close(pageSignal),
            Reason.DomCallback,
            "close shared thread selection",
          );
        }}
      >
        {t(($) => {
          return $.chat.sharing.cancel;
        })}
      </Button>
    </div>
  );
}

function MobileSharingOverlayLeaf() {
  const leftThread = useGet(currentLeftThread$);
  const rightThread = useGet(currentRightThread$);
  const thread = leftThread ?? rightThread;
  return thread ? <MobileSharingOverlayInner thread={thread} /> : null;
}

function MobileTopBarActions({ activeId }: { activeId: RouteKey | null }) {
  const inChatRoute = isChatRoute(activeId);
  const showInviteFallback = inChatRoute && activeId !== "chat";
  return (
    <>
      {inChatRoute && <MobileShareButtonLeaf />}
      {inChatRoute && <MobileAutomationButtonLeaf />}
      {inChatRoute && <MobileArtifactsButtonLeaf />}
      {showInviteFallback && <InviteButtonLeaf />}
    </>
  );
}

function MobileTopBar() {
  const setExpanded = useSet(setSidebarExpanded$);
  const { t } = useTranslation();

  const breadcrumbLoadable = useLastLoadable(mobileBreadcrumb$);
  const breadcrumb =
    breadcrumbLoadable.state === "hasData" ? breadcrumbLoadable.data : null;

  const activeId = useGet(activeRoute$);

  return (
    <div className="relative md:hidden shrink-0 flex items-center min-h-12 px-3 gap-2 bg-background border-b border-border/50 z-10">
      <MobileSharingOverlayLeaf />
      <Button
        showTooltip
        type="button"
        onClick={() => {
          setExpanded(true);
        }}
        variant="quiet"
        size="icon-sm"
        iconSize="md"
        className="shrink-0"
        aria-label={t(($) => {
          return $.appShell.sidebar.mobile.openMenu;
        })}
      >
        <Menu size={18} />
      </Button>
      {breadcrumb && (
        <div className="flex-1 min-w-0 flex items-center gap-2 min-w-0">
          {breadcrumb.avatarAgentId && <AgentAvatarInTopBar />}
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm font-medium text-foreground flex items-center gap-1 min-w-0">
              {breadcrumb.sectionPath ? (
                <Link
                  pathname={breadcrumb.sectionPath}
                  options={breadcrumb.sectionOptions}
                  className="hover:opacity-70 transition-opacity no-underline text-inherit"
                >
                  {breadcrumb.section}
                </Link>
              ) : (
                <span>{breadcrumb.section}</span>
              )}
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

function SettingsDialogMount() {
  const dialogOpen = useGet(settingsDialogOpen$);
  const closeSettingsModal = useSet(closeSettingsModal$);

  return (
    <SettingsDialog
      open={dialogOpen}
      onOpenChange={(open) => {
        if (!open) {
          closeSettingsModal();
        }
      }}
    />
  );
}

function AttachmentLightboxMount() {
  const lightboxUrl = useGet(lightboxUrl$);
  return lightboxUrl ? <AttachmentLightbox /> : null;
}

function MobileSidebarMount() {
  const expanded = useGet(sidebarExpanded$);
  const setExpanded = useSet(setSidebarExpanded$);
  const { t } = useTranslation();

  return (
    <>
      <Sidebar isDesktop={false} />
      <div
        data-sidebar-expanded={expanded || undefined}
        className="zero-pwa-fixed-cover fixed inset-0 z-30 bg-black/40 hidden data-[sidebar-expanded]:max-md:block"
        aria-label={t(($) => {
          return $.appShell.sidebar.mobile.overlay;
        })}
        onClick={() => {
          return setExpanded(false);
        }}
      />
    </>
  );
}

function SidebarLayoutInner({ children }: { children: ReactNode }) {
  const colorTheme = useGet(colorTheme$);
  const features = useGet(featureSwitch$);
  const gradientColorThemesEnabled =
    features[FeatureSwitchKey.GradientColorThemes] ?? false;
  const geistTypefaceEnabled =
    features[FeatureSwitchKey.GeistTypeface] ?? false;
  const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_MEDIA_QUERY);

  return (
    <div
      ref={(element) => {
        applyColorThemeDocumentAttributes(
          element !== null && gradientColorThemesEnabled,
          colorTheme,
        );
        applyTypefaceDocumentAttribute(
          element !== null && geistTypefaceEnabled,
        );
      }}
      className="zero-app zero-viewport-shell flex w-full bg-background"
      data-gradient-color-themes={gradientColorThemesEnabled || undefined}
      data-color-theme={gradientColorThemesEnabled ? colorTheme : undefined}
    >
      <SettingsDialogMount />
      <ChatShortcutHelpDialog />
      <ConcurrencyConfirmDialog />
      <CreditPurchaseConfirmDialog />
      <SubscriptionPurchaseConfirmDialog />
      <AttachmentLightboxMount />
      <QueueDrawer />
      {isDesktop ? <Sidebar isDesktop /> : <MobileSidebarMount />}
      <div className="flex flex-1 flex-col min-w-0 min-h-0 zero-workspace-bg">
        <InstallBanner />
        <IosInstallModal />
        {!isDesktop && <MobileTopBar />}
        {children}
      </div>
    </div>
  );
}

export function SidebarLayout({ children }: { children: ReactNode }) {
  return <SidebarLayoutInner>{children}</SidebarLayoutInner>;
}
