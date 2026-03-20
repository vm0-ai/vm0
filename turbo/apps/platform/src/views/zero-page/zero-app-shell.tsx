/* eslint-disable ccstate/no-use-ccstate-in-views */
import { useCCState, useCommand } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import {
  ZeroSidebar,
  useAgentAvatar,
  type ZeroNavId,
  type ZeroAccountAction,
  type SubagentInfo,
} from "./zero-sidebar.tsx";
import { Button } from "@vm0/ui";
import { ZeroAboutPage } from "./zero-about-page.tsx";
import { ZeroContent } from "./zero-content.tsx";
import { ZeroOnboarding, MemberWelcome } from "./zero-onboarding.tsx";
import { user$ } from "../../signals/auth.ts";
import {
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "../../signals/zero-page/zero-onboarding.ts";
import {
  agentDisplayName$,
  defaultAgentName$,
} from "../../signals/zero-page/zero-agent-name.ts";
import { zeroSubagents$ } from "../../signals/zero-page/zero-agents.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  zeroActiveId$,
  zeroInChat$,
  zeroSessionId$,
  zeroChatAgentId$,
  zeroChatAgentName$,
  zeroTalkAgentResolved$,
  setZeroActiveId$,
  navigateToZeroSession$,
  navigateFromZeroSession$,
} from "../../signals/zero-page/zero-nav.ts";
import { updatePathname$, navigateInReact$ } from "../../signals/route.ts";
import {
  zeroSessionList$,
  zeroSessionListLoading$,
  zeroSessionListError$,
  zeroChatThreadId$,
  switchZeroSession$,
  startNewZeroSession$,
  sendZeroChatMessage$,
} from "../../signals/zero-page/zero-chat.ts";

import zeroAvatarImg from "./assets/zero-avatar.png";
import avatar1Img from "./assets/avatar-1.png";
import avatar2Img from "./assets/avatar-2.png";
import avatar3Img from "./assets/avatar-3.png";
import avatar4Img from "./assets/avatar-4.png";

const ZERO_AVATARS = [
  zeroAvatarImg,
  avatar1Img,
  avatar2Img,
  avatar3Img,
  avatar4Img,
] as const;

function ZeroAppSkeleton({ visible }: { visible: boolean }) {
  return (
    <div
      className={`fixed inset-0 z-50 flex bg-background ${
        visible
          ? "opacity-100"
          : "opacity-0 pointer-events-none transition-opacity duration-300"
      }`}
    >
      {/* Sidebar skeleton */}
      <aside className="flex h-full w-[255px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar overflow-hidden">
        {/* Org switcher */}
        <div className="shrink-0 p-2 pb-1">
          <div className="rounded-lg p-2">
            <div className="h-8 w-full rounded-lg bg-muted/50 animate-pulse" />
          </div>
        </div>
        {/* Nav + Recent */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden p-2">
          <div className="flex flex-col gap-1">
            {["nav-1", "nav-2", "nav-3", "nav-4", "nav-5", "nav-6"].map(
              (id, i) => (
                <div
                  key={id}
                  className="flex h-8 items-center gap-2 rounded-lg p-2"
                >
                  <div className="h-4 w-4 rounded bg-muted/50 animate-pulse shrink-0" />
                  <div
                    className="h-3.5 rounded bg-muted/50 animate-pulse"
                    style={{ width: `${80 + ((i * 37) % 60)}px` }}
                  />
                </div>
              ),
            )}
          </div>
          {/* Recent section */}
          <div className="mt-4">
            <div className="h-8 flex items-center px-2">
              <div className="h-3 w-20 rounded bg-muted/30 animate-pulse" />
            </div>
            <div className="flex flex-col gap-1">
              {["recent-1", "recent-2", "recent-3"].map((id, i) => (
                <div key={id} className="flex h-8 items-center rounded-lg p-2">
                  <div
                    className="h-3.5 rounded bg-muted/40 animate-pulse"
                    style={{ width: `${100 + ((i * 43) % 80)}px` }}
                  />
                </div>
              ))}
            </div>
          </div>
        </nav>
        {/* Footer */}
        <div className="p-2">
          <div className="flex flex-col gap-1">
            <div className="flex h-8 items-center gap-2 rounded-lg p-2">
              <div className="h-4 w-4 rounded bg-muted/50 animate-pulse shrink-0" />
              <div className="h-3.5 w-28 rounded bg-muted/50 animate-pulse" />
            </div>
            {/* Account */}
            <div className="mt-2 pt-1">
              <div className="rounded-lg p-2">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 shrink-0 rounded-xl bg-muted/50 animate-pulse" />
                  <div className="flex-1 min-w-0">
                    <div className="h-3.5 w-24 rounded bg-muted/50 animate-pulse" />
                    <div className="h-3 w-32 rounded bg-muted/30 animate-pulse mt-1" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
      {/* Content skeleton */}
      <div className="flex flex-1 flex-col min-w-0 zero-workspace-bg">
        <div className="shrink-0 px-6 pt-6 pb-5">
          <div className="h-6 w-40 rounded bg-muted/50 animate-pulse mb-2" />
          <div className="h-4 w-64 rounded bg-muted/30 animate-pulse" />
        </div>
        <div className="flex-1 px-6">
          <div className="mx-auto max-w-[900px]">
            <div className="h-48 rounded-xl bg-muted/20 animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  );
}

function useSkeletonVisibility(isLoggedIn: boolean, dataReady: boolean) {
  return isLoggedIn && !dataReady;
}

/**
 * Manages session lifecycle: fetches session list when onboarding completes,
 * and auto-sends an introductory message for new users.
 */
function useSessionLifecycle() {
  const recentSessions = useGet(zeroSessionList$);
  const recentSessionsLoading = useGet(zeroSessionListLoading$);
  const recentSessionsError = useGet(zeroSessionListError$);
  return { recentSessions, recentSessionsLoading, recentSessionsError };
}

/**
 * Sync URL session ID to the chat signal, avoiding redundant switches.
 */
function useUrlSessionSync(
  urlSessionId: string | null,
  currentSessionId: string | null,
  switchSession: (id: string) => Promise<void>,
) {
  const lastDispatched$ = useCCState<string | null>(null);
  const lastDispatched = useGet(lastDispatched$);
  const setLastDispatched = useSet(lastDispatched$);
  if (
    urlSessionId &&
    urlSessionId !== lastDispatched &&
    urlSessionId !== currentSessionId
  ) {
    setLastDispatched(urlSessionId);
    queueMicrotask(() => {
      detach(switchSession(urlSessionId), Reason.DomCallback);
    });
  } else if (!urlSessionId) {
    setLastDispatched(null);
  }
}

function GuestNavBar({ onAbout }: { onAbout: () => void }) {
  return (
    <nav
      className="pointer-events-none absolute right-6 top-6 z-10"
      aria-label="Site links"
    >
      <div className="zero-float-card pointer-events-auto flex items-center gap-4 rounded-xl border border-border bg-card/95 px-4 py-2.5 backdrop-blur-sm">
        <button
          type="button"
          onClick={onAbout}
          className="text-sm tracking-wide text-foreground hover:text-primary transition-colors duration-200"
        >
          About VM0
        </button>
        <a
          href="https://vm0.ai/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm tracking-wide text-foreground hover:text-primary transition-colors duration-200"
        >
          Pricing
        </a>
        <a href="/sign-in">
          <Button size="sm" className="h-9 rounded-lg px-4 text-sm font-medium">
            Sign in
          </Button>
        </a>
      </div>
    </nav>
  );
}

function useContentNavigation(resolvedAgentName: string | null) {
  const navigate = useSet(updatePathname$);
  const navigateInReact = useSet(navigateInReact$);

  const handleNavigateToSchedule = () => {
    if (resolvedAgentName) {
      navigateInReact("/team/:name", {
        pathParams: { name: resolvedAgentName },
        searchParams: new URLSearchParams({ tab: "schedule" }),
      });
    }
  };

  const handleNavigateToMeet = (tab?: string) => {
    if (resolvedAgentName) {
      const searchParams = tab ? new URLSearchParams({ tab }) : undefined;
      navigateInReact("/team/:name", {
        pathParams: { name: resolvedAgentName },
        searchParams,
      });
    }
  };

  const handleChatAvatarClick = () => {
    if (resolvedAgentName) {
      navigateInReact("/team/:name", {
        pathParams: { name: resolvedAgentName },
      });
    }
  };

  return {
    navigate,
    navigateInReact,
    handleNavigateToSchedule,
    handleNavigateToMeet,
    handleChatAvatarClick,
  };
}

function useZeroLoadables() {
  const userLoadable = useLoadable(user$);
  const isLoggedIn =
    userLoadable.state === "hasData" && userLoadable.data !== undefined;
  const onboardingLoadable = useLastLoadable(zeroNeedsOnboarding$);
  const onboardingReady = onboardingLoadable.state === "hasData";
  const needsOnboarding =
    onboardingLoadable.state === "hasData" && onboardingLoadable.data === true;
  const agentDisplayNameLoadable = useLastLoadable(agentDisplayName$);
  const agentNameReady = agentDisplayNameLoadable.state === "hasData";
  const agentDisplayName = agentNameReady
    ? agentDisplayNameLoadable.data
    : "Zero";
  const defaultAgentNameLoadable = useLastLoadable(defaultAgentName$);
  const defaultRawName =
    defaultAgentNameLoadable.state === "hasData"
      ? defaultAgentNameLoadable.data
      : null;
  const subagentsLoadable = useLastLoadable(zeroSubagents$);
  const subagents: SubagentInfo[] =
    subagentsLoadable.state === "hasData"
      ? subagentsLoadable.data.map((a) => ({
          id: a.id,
          name: a.name,
          displayName: a.displayName,
        }))
      : [];
  const memberOnboarding = useLastLoadable(zeroNeedsMemberOnboarding$);
  const showMemberWelcome =
    isLoggedIn &&
    memberOnboarding.state === "hasData" &&
    memberOnboarding.data === true;
  return {
    isLoggedIn,
    onboardingReady,
    needsOnboarding,
    showOnboarding: isLoggedIn && needsOnboarding,
    showMemberWelcome,
    agentNameReady,
    agentDisplayName,
    defaultRawName,
    subagents,
  };
}

interface ZeroAppShellProps {
  initialJobAgent?: string | null;
}

export function ZeroAppShell({ initialJobAgent }: ZeroAppShellProps) {
  const {
    isLoggedIn,
    onboardingReady,
    showOnboarding,
    showMemberWelcome,
    agentNameReady,
    agentDisplayName,
    defaultRawName,
    subagents,
  } = useZeroLoadables();
  const currentChatAgentId = useGet(zeroChatAgentId$);

  const activeId = useGet(zeroActiveId$);
  const avatarIndex$ = useCCState(0);
  const avatarIndex = useGet(avatarIndex$);
  const setAvatarIndex = useSet(avatarIndex$);
  const showAboutPage$ = useCCState(false);
  const showAboutPage = useGet(showAboutPage$);
  const setShowAboutPage = useSet(showAboutPage$);
  const zeroAvatarSrc = ZERO_AVATARS[avatarIndex] ?? ZERO_AVATARS[0];
  const cycleZeroAvatar = () =>
    setAvatarIndex((avatarIndex + 1) % ZERO_AVATARS.length);

  // Resolve the effective agent name/avatar for the chat page
  const selectedSubagent = currentChatAgentId
    ? subagents.find((a) => a.id === currentChatAgentId)
    : null;
  const chatAgentName = selectedSubagent
    ? (selectedSubagent.displayName ?? selectedSubagent.name)
    : agentDisplayName;
  const subagentAvatarSrc = useAgentAvatar(selectedSubagent?.name ?? "");
  const chatAvatarSrc = selectedSubagent ? subagentAvatarSrc : zeroAvatarSrc;
  const inChat = useGet(zeroInChat$);
  const urlSessionId = useGet(zeroSessionId$);
  const inSession = inChat;
  const currentThreadId = useGet(zeroChatThreadId$);
  const switchSession = useSet(switchZeroSession$);
  const startNewSession = useSet(startNewZeroSession$);
  const sendMessage = useSet(sendZeroChatMessage$);

  // When visiting /talk/:name, wait for the agent to be resolved
  const talkAgentName = useGet(zeroChatAgentName$);
  const talkAgentResolved = useGet(zeroTalkAgentResolved$);
  const talkAgentReady = !talkAgentName || talkAgentResolved;

  const { recentSessions, recentSessionsLoading, recentSessionsError } =
    useSessionLifecycle();

  // Sync URL thread ID to chat signal (skip if signal already matches)
  useUrlSessionSync(urlSessionId, currentThreadId, switchSession);

  const resolvedAgentName = selectedSubagent?.name ?? defaultRawName;
  const {
    navigateInReact,
    handleNavigateToSchedule,
    handleNavigateToMeet,
    handleChatAvatarClick,
  } = useContentNavigation(resolvedAgentName);

  const handleRecentSelect$ = useCommand(({ set }, sessionId: string) => {
    set(navigateToZeroSession$, sessionId);
  });
  const handleRecentSelect = useSet(handleRecentSelect$);

  const handleNewChat = (agent: { id: string; name: string } | null) => {
    startNewSession();
    // navigateInReact triggers loadRoute$ → setupZeroPage$ → resolveAndSwitchAgent
    // which sets the agent and fetches the session list.
    if (agent) {
      navigateInReact("/talk/:name", {
        pathParams: { name: agent.name },
      });
    } else {
      navigateInReact("/");
    }
  };

  const handleSendFromDemo$ = useCommand(
    ({ set }, message: string, options?: { modelProvider?: string }) => {
      set(updatePathname$, "/chat");
      startNewSession();
      detach(sendMessage(message, options), Reason.DomCallback);
    },
  );
  const handleSendFromDemo = useSet(handleSendFromDemo$);

  const handleBackFromSession$ = useCommand(({ set }) => {
    set(navigateFromZeroSession$);
  });
  const handleBackFromSession = useSet(handleBackFromSession$);

  const handleNavSelect$ = useCommand(({ set }, id: ZeroNavId) => {
    set(setZeroActiveId$, id);
    set(showAboutPage$, false);
  });
  const handleNavSelect = useSet(handleNavSelect$);

  const handleAccountAction$ = useCommand(
    ({ set }, action: ZeroAccountAction) => {
      if (action === "signout" || action === "manage") {
        return;
      }
      if (action === "preferences") {
        set(setZeroActiveId$, "preferences");
      }
    },
  );
  const handleAccountAction = useSet(handleAccountAction$);

  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
  const sidebarCollapsed$ = useCCState(isMobile);
  const sidebarCollapsed = useGet(sidebarCollapsed$);
  const setSidebarCollapsed = useSet(sidebarCollapsed$);

  const dataReady =
    isLoggedIn && onboardingReady && agentNameReady && talkAgentReady;
  const showSkeleton = useSkeletonVisibility(isLoggedIn, dataReady);

  return (
    <div className="zero-app flex h-dvh w-full bg-background">
      <ZeroAppSkeleton visible={showSkeleton} />
      {showOnboarding && <ZeroOnboarding zeroAvatarSrc={zeroAvatarSrc} />}
      {showMemberWelcome && (
        <MemberWelcome
          agentName={agentDisplayName}
          zeroAvatarSrc={zeroAvatarSrc}
        />
      )}
      <ZeroSidebar
        activeId={activeId}
        agentName={agentDisplayName}
        defaultAgentRawName={defaultRawName}
        zeroAvatarSrc={zeroAvatarSrc}
        subagents={subagents}
        currentChatAgentId={currentChatAgentId}
        collapsed={sidebarCollapsed}
        onCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        onSelect={handleNavSelect}
        onRecentSelect={handleRecentSelect}
        selectedRecentId={urlSessionId}
        onAccountAction={handleAccountAction}
        recentSessions={recentSessions}
        recentSessionsLoading={recentSessionsLoading}
        recentSessionsError={recentSessionsError}
        onNewChat={handleNewChat}
      />
      {/* Mobile backdrop when sidebar is open */}
      {!sidebarCollapsed && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setSidebarCollapsed(true)}
        />
      )}
      <div className="flex flex-1 flex-col min-w-0 min-h-0 zero-workspace-bg">
        {/* TopBarActions (credit & invite) hidden until feature is ready */}
        {!isLoggedIn && <GuestNavBar onAbout={() => setShowAboutPage(true)} />}
        {showAboutPage ? (
          <ZeroAboutPage onBack={() => setShowAboutPage(false)} />
        ) : (
          <ZeroContent
            sectionId={activeId}
            inSession={inSession}
            onSendMessage={handleSendFromDemo}
            selectedAgentName={initialJobAgent}
            onNavigateToSchedule={handleNavigateToSchedule}
            onNavigateToMeet={handleNavigateToMeet}
            onBackFromSession={handleBackFromSession}
            zeroAvatarSrc={zeroAvatarSrc}
            chatAgentName={chatAgentName}
            chatAvatarSrc={chatAvatarSrc}
            onChatAvatarClick={handleChatAvatarClick}
            onCycleZeroAvatar={cycleZeroAvatar}
          />
        )}
      </div>
    </div>
  );
}
