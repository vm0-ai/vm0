import { useLoadable } from "ccstate-react";
import type { ZeroNavId, ZeroAccountSubId } from "./zero-sidebar.tsx";
import { ZeroChatPage, type DemoScenarioId } from "./zero-chat-page.tsx";
import { ZeroAccountPage } from "./zero-account-page.tsx";
import { ZeroJobsPage } from "./zero-jobs-page.tsx";
import { ZeroMeetPage } from "./zero-meet-page.tsx";
import { ZeroProductionPage } from "./zero-production-page.tsx";
import { ZeroActivityPage } from "./zero-activity-page.tsx";
import { ZeroWorksPage } from "./zero-works-page.tsx";
import { ZeroSchedulePage } from "./zero-schedule-page.tsx";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";

const RECENT_ID_TO_SCENARIO: Readonly<Record<string, DemoScenarioId>> = {
  hello: "hello-from-zero",
  "1": "rich-summary",
  "2": "connect-connector",
  "3": "agent-operations",
  "4": "approve",
};

interface ZeroContentProps {
  sectionId: ZeroNavId;
  accountSubId?: ZeroAccountSubId | null;
  recentLabel?: string | null;
  recentId?: string | null;
  onClearRecent?: () => void;
  onNavigateToActivity?: () => void;
  onNavigateToSchedule?: () => void;
  onNavigateToJob?: () => void;
  onNavigateToChat?: () => void;
  onNavigateToMeet?: (tab?: string) => void;
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
    production: "Documents",
    activity: "Activities",
    works: `Where ${agentName} works`,
    account: "Account",
  };
}

export function ZeroContent({
  sectionId,
  accountSubId = null,
  recentLabel,
  recentId,
  onClearRecent,
  onNavigateToActivity,
  onNavigateToSchedule,
  onNavigateToJob,
  onNavigateToChat,
  onNavigateToMeet,
  zeroAvatarSrc = "/zero-avatar.png",
  onAvatarClick,
}: ZeroContentProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  if (sectionId === "chat") {
    const initialScenarioId = recentId
      ? (RECENT_ID_TO_SCENARIO[recentId] ?? undefined)
      : undefined;
    return (
      <ZeroChatPage
        initialScenarioId={initialScenarioId}
        onClearScenario={onClearRecent}
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
  if (sectionId === "production") {
    return <ZeroProductionPage />;
  }
  if (sectionId === "activity") {
    return <ZeroActivityPage />;
  }
  if (sectionId === "works") {
    return <ZeroWorksPage />;
  }
  if (sectionId === "account") {
    return <ZeroAccountPage accountSubId={accountSubId ?? null} />;
  }

  const title = recentLabel ?? getSectionTitles(agentName)[sectionId];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 border-b border-divider bg-transparent px-4 sm:px-6 pt-6 sm:pt-6 pb-4 sm:pb-5">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {recentLabel
            ? `Continue your dialogue with ${agentName}`
            : `${agentName} — your AI assistant`}
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
