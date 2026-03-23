import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import {
  ZeroSidebar,
  useAgentAvatar,
  type SubagentInfo,
} from "./zero-sidebar.tsx";
import { Button } from "@vm0/ui";
import { ZeroAboutPage } from "./zero-about-page.tsx";
import { ZeroContent } from "./zero-content.tsx";
import { ZeroOnboarding, MemberWelcome } from "./zero-onboarding.tsx";
import { AppSkeleton } from "./app-skeleton.tsx";
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
import {
  zeroActiveId$,
  zeroInChat$,
  zeroChatAgentId$,
  zeroChatAgentName$,
  zeroTalkAgentResolved$,
  zeroAvatarIndex$,
  zeroShowAboutPage$,
  setZeroShowAboutPage$,
  zeroSidebarCollapsed$,
  setZeroSidebarCollapsed$,
} from "../../signals/zero-page/zero-nav.ts";
import { navigateTo$ } from "../../signals/route.ts";
import { sendFromZeroDemo$ } from "../../signals/zero-page/zero-chat.ts";

import zeroAvatarImg from "./assets/zero-avatar.webp";
import avatar1Img from "./assets/avatar-1.webp";
import avatar2Img from "./assets/avatar-2.webp";
import avatar3Img from "./assets/avatar-3.webp";
import avatar4Img from "./assets/avatar-4.webp";

const ZERO_AVATARS = [
  zeroAvatarImg,
  avatar1Img,
  avatar2Img,
  avatar3Img,
  avatar4Img,
] as const;

function useSkeletonVisibility(isLoggedIn: boolean, dataReady: boolean) {
  return isLoggedIn && !dataReady;
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
  const navigateTo = useSet(navigateTo$);

  const handleNavigateToSchedule = () => {
    if (resolvedAgentName) {
      navigateTo("/team/:name", {
        pathParams: { name: resolvedAgentName },
        searchParams: new URLSearchParams({ tab: "schedule" }),
      });
    }
  };

  const handleNavigateToMeet = (tab?: string) => {
    if (resolvedAgentName) {
      const searchParams = tab ? new URLSearchParams({ tab }) : undefined;
      navigateTo("/team/:name", {
        pathParams: { name: resolvedAgentName },
        searchParams,
      });
    }
  };

  const handleChatAvatarClick = () => {
    if (resolvedAgentName) {
      navigateTo("/team/:name", {
        pathParams: { name: resolvedAgentName },
      });
    }
  };

  return {
    navigateTo,
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

export function ZeroAppShell() {
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
  const avatarIndex = useGet(zeroAvatarIndex$);
  const showAboutPage = useGet(zeroShowAboutPage$);
  const setShowAboutPage = useSet(setZeroShowAboutPage$);
  const zeroAvatarSrc = ZERO_AVATARS[avatarIndex] ?? ZERO_AVATARS[0];

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
  const inSession = inChat;
  const handleSendFromDemo = useSet(sendFromZeroDemo$);

  // When visiting /talk/:name, wait for the agent to be resolved
  const talkAgentName = useGet(zeroChatAgentName$);
  const talkAgentResolved = useGet(zeroTalkAgentResolved$);
  const talkAgentReady = !talkAgentName || talkAgentResolved;

  const resolvedAgentName = selectedSubagent?.name ?? defaultRawName;
  const {
    handleNavigateToSchedule,
    handleNavigateToMeet,
    handleChatAvatarClick,
  } = useContentNavigation(resolvedAgentName);

  const sidebarCollapsed = useGet(zeroSidebarCollapsed$);
  const setSidebarCollapsed = useSet(setZeroSidebarCollapsed$);

  const dataReady =
    isLoggedIn && onboardingReady && agentNameReady && talkAgentReady;
  const showSkeleton = useSkeletonVisibility(isLoggedIn, dataReady);

  return (
    <div className="zero-app flex h-dvh w-full bg-background">
      <AppSkeleton visible={showSkeleton} />
      {showOnboarding && <ZeroOnboarding zeroAvatarSrc={zeroAvatarSrc} />}
      {showMemberWelcome && (
        <MemberWelcome
          agentName={agentDisplayName}
          zeroAvatarSrc={zeroAvatarSrc}
        />
      )}
      <ZeroSidebar />
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
            onNavigateToSchedule={handleNavigateToSchedule}
            onNavigateToMeet={handleNavigateToMeet}
            zeroAvatarSrc={zeroAvatarSrc}
            chatAgentName={chatAgentName}
            chatAvatarSrc={chatAvatarSrc}
            onChatAvatarClick={handleChatAvatarClick}
          />
        )}
      </div>
    </div>
  );
}
