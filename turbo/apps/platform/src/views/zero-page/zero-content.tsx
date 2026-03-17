import { useLoadable } from "ccstate-react";
import type { ZeroNavId } from "./zero-sidebar.tsx";
import { ZeroChatPage } from "./zero-chat-page.tsx";
import { ZeroSessionChatPage } from "./zero-session-chat-page.tsx";
import { ZeroPreferencesPage } from "./zero-account-page.tsx";
import { ZeroJobsPage } from "./zero-jobs-page.tsx";
import { ZeroActivityPage } from "./zero-activity-page.tsx";
import { ZeroWorksPage } from "./zero-works-page.tsx";
import { ZeroSchedulePage } from "./zero-schedule-page.tsx";
import { ZeroSettingsPage } from "./zero-settings-page.tsx";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import zeroAvatarImg from "./assets/zero-avatar.png";

interface ZeroContentProps {
  sectionId: ZeroNavId;
  /** When set, shows the real session chat page instead of the demo page. */
  inSession?: boolean;
  onSendMessage?: (
    message: string,
    options?: { modelProvider?: string },
  ) => void;
  onNavigateToSchedule?: () => void;
  selectedAgentName?: string | null;
  onNavigateToMeet?: (tab?: string) => void;
  onBackFromSession?: () => void;
  zeroAvatarSrc?: string;
  /** Override agent name for the chat page when a sub-agent is selected. */
  chatAgentName?: string;
  /** Override avatar for the chat page when a sub-agent is selected. */
  chatAvatarSrc?: string;
  /** Navigate to agent profile — clicking chat header avatar. */
  onChatAvatarClick?: () => void;
  /** Cycle the default agent (Zero) avatar. */
  onCycleZeroAvatar?: () => void;
}

function getSectionTitles(
  agentName: string,
): Readonly<Record<ZeroNavId, string>> {
  return {
    chat: `Chat with ${agentName}`,
    schedule: "Scheduled",
    team: `${agentName}'s team`,
    activity: "Activities",
    works: `Where ${agentName} works`,
    settings: "Settings",
    preferences: "Preferences",
  };
}

export function ZeroContent({
  sectionId,
  inSession = false,
  onSendMessage,
  onNavigateToSchedule,
  selectedAgentName,
  onNavigateToMeet,
  onBackFromSession,
  zeroAvatarSrc = zeroAvatarImg,
  chatAgentName,
  chatAvatarSrc,
  onChatAvatarClick,
  onCycleZeroAvatar,
}: ZeroContentProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  if (sectionId === "chat") {
    if (inSession) {
      return (
        <ZeroSessionChatPage
          zeroAvatarSrc={chatAvatarSrc ?? zeroAvatarSrc}
          chatAgentName={chatAgentName}
          onBack={onBackFromSession}
          onNavigateToSchedule={onNavigateToSchedule}
          onAvatarClick={onChatAvatarClick}
        />
      );
    }
    return (
      <ZeroChatPage
        onSendMessage={onSendMessage}
        onNavigateToSchedule={onNavigateToSchedule}
        onNavigateToMeet={onNavigateToMeet}
        zeroAvatarSrc={chatAvatarSrc ?? zeroAvatarSrc}
        chatAgentName={chatAgentName}
      />
    );
  }
  if (sectionId === "schedule") {
    return <ZeroSchedulePage />;
  }
  if (sectionId === "team") {
    return (
      <ZeroJobsPage
        selectedAgentName={selectedAgentName}
        zeroAvatarSrc={zeroAvatarSrc}
        onCycleZeroAvatar={onCycleZeroAvatar}
      />
    );
  }
  if (sectionId === "activity") {
    return <ZeroActivityPage />;
  }
  if (sectionId === "works") {
    return <ZeroWorksPage />;
  }
  if (sectionId === "settings") {
    return <ZeroSettingsPage />;
  }
  if (sectionId === "preferences") {
    return <ZeroPreferencesPage />;
  }

  const title = getSectionTitles(agentName)[sectionId];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 border-b border-divider bg-transparent px-4 sm:px-6 pt-6 sm:pt-6 pb-4 sm:pb-5">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {agentName} — your AI assistant
        </p>
      </header>
      <main className="flex-1 overflow-auto px-4 sm:px-6 pb-8">
        <div className="mx-auto max-w-[900px]">
          <div className="zero-card p-6">
            <p className="text-sm text-muted-foreground">
              Content for &quot;{title}&quot; will appear here.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
