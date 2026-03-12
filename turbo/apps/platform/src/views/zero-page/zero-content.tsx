import { useLoadable } from "ccstate-react";
import type { ZeroNavId, ZeroAccountSubId } from "./zero-sidebar.tsx";
import { ZeroChatPage } from "./zero-chat-page.tsx";
import { ZeroSessionChatPage } from "./zero-session-chat-page.tsx";
import { ZeroAccountPage } from "./zero-account-page.tsx";
import { ZeroJobsPage } from "./zero-jobs-page.tsx";
import { ZeroMeetPage } from "./zero-meet-page.tsx";
import { ZeroActivityPage } from "./zero-activity-page.tsx";
import { ZeroWorksPage } from "./zero-works-page.tsx";
import { ZeroSchedulePage } from "./zero-schedule-page.tsx";
import { ZeroSettingsPage } from "./zero-settings-page.tsx";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";

interface ZeroContentProps {
  sectionId: ZeroNavId;
  accountSubId?: ZeroAccountSubId | null;
  /** When set, shows the real session chat page instead of the demo page. */
  inSession?: boolean;
  onSendMessage?: (message: string) => void;
  onNavigateToActivity?: () => void;
  onNavigateToSchedule?: () => void;
  onNavigateToJob?: () => void;
  onNavigateToChat?: () => void;
  onNavigateToMeet?: (tab?: string) => void;
  onBackFromSession?: () => void;
  zeroAvatarSrc?: string;
  onAvatarClick?: () => void;
}

function getSectionTitles(
  agentName: string,
): Readonly<Record<ZeroNavId, string>> {
  return {
    chat: `Chat with ${agentName}`,
    meet: `Meet ${agentName}`,
    schedule: "Schedule",
    job: `${agentName}'s team`,
    activity: "Activities",
    works: `Where ${agentName} works`,
    settings: "Settings",
    account: "Account",
  };
}

export function ZeroContent({
  sectionId,
  accountSubId = null,
  inSession = false,
  onSendMessage,
  onNavigateToActivity,
  onNavigateToSchedule,
  onNavigateToJob,
  onNavigateToChat,
  onNavigateToMeet,
  onBackFromSession,
  zeroAvatarSrc = "/zero-avatar.png",
  onAvatarClick,
}: ZeroContentProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  if (sectionId === "chat") {
    if (inSession) {
      return (
        <ZeroSessionChatPage
          zeroAvatarSrc={zeroAvatarSrc}
          onAvatarClick={onAvatarClick}
          onBack={onBackFromSession}
          onNavigateToJob={onNavigateToJob}
          onNavigateToSchedule={onNavigateToSchedule}
        />
      );
    }
    return (
      <ZeroChatPage
        onSendMessage={onSendMessage}
        onNavigateToActivity={onNavigateToActivity}
        onNavigateToSchedule={onNavigateToSchedule}
        onNavigateToJob={onNavigateToJob}
        onNavigateToMeet={onNavigateToMeet}
        zeroAvatarSrc={zeroAvatarSrc}
        onAvatarClick={onAvatarClick}
      />
    );
  }
  if (sectionId === "meet") {
    return (
      <ZeroMeetPage
        zeroAvatarSrc={zeroAvatarSrc}
        onAvatarClick={onAvatarClick}
      />
    );
  }
  if (sectionId === "schedule") {
    return <ZeroSchedulePage />;
  }
  if (sectionId === "job") {
    return <ZeroJobsPage onNavigateToChat={onNavigateToChat} />;
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
  if (sectionId === "account") {
    return <ZeroAccountPage accountSubId={accountSubId ?? null} />;
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
              Content for “{title}” will appear here.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
