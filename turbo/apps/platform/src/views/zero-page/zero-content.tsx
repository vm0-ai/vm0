import type { ZeroNavId } from "./zero-sidebar.tsx";
import { ZeroChatPage, type DemoScenarioId } from "./zero-chat-page.tsx";
import { ZeroJobsPage } from "./zero-jobs-page.tsx";
import { ZeroMeetPage } from "./zero-meet-page.tsx";
import { ZeroProductionPage } from "./zero-production-page.tsx";
import { ZeroActivityPage } from "./zero-activity-page.tsx";
import { ZeroWorksPage } from "./zero-works-page.tsx";
import { ZeroTeamPage } from "./zero-team-page.tsx";

const RECENT_ID_TO_SCENARIO: Record<string, DemoScenarioId> = {
  "1": "rich-summary",
  "2": "connect-connector",
  "3": "agent-operations",
  "4": "approve",
};

interface ZeroContentProps {
  sectionId: ZeroNavId;
  recentLabel?: string | null;
  recentId?: string | null;
  onClearRecent?: () => void;
  onNavigateToActivity?: () => void;
}

const SECTION_TITLES: Record<ZeroNavId, string> = {
  chat: "Chat with Zero",
  meet: "Meet Zero",
  job: "Zero's job",
  production: "Zero's production",
  activity: "Zero's activity",
  works: "Where Zero works",
  team: "Zero's team",
  account: "Account",
};

export function ZeroContent({
  sectionId,
  recentLabel,
  recentId,
  onClearRecent,
  onNavigateToActivity,
}: ZeroContentProps) {
  if (sectionId === "chat") {
    const initialScenarioId = recentId
      ? (RECENT_ID_TO_SCENARIO[recentId] ?? undefined)
      : undefined;
    return (
      <ZeroChatPage
        initialScenarioId={initialScenarioId}
        onClearScenario={onClearRecent}
        onNavigateToActivity={onNavigateToActivity}
      />
    );
  }
  if (sectionId === "meet") {
    return <ZeroMeetPage />;
  }
  if (sectionId === "job") {
    return <ZeroJobsPage />;
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
  if (sectionId === "team") {
    return <ZeroTeamPage />;
  }

  const title = recentLabel ?? SECTION_TITLES[sectionId];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 border-b border-divider bg-transparent px-4 sm:px-6 pt-6 sm:pt-6 pb-4 sm:pb-5">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-1 text-sm sm:text-base text-muted-foreground">
          {recentLabel
            ? "Continue your dialogue with Zero"
            : "Zero — your AI assistant"}
        </p>
      </header>
      <main className="flex-1 overflow-auto px-4 sm:px-6 pb-8">
        <div className="mx-auto max-w-[1200px]">
          <div className="rounded-xl border border-border bg-card p-6">
            <p className="text-sm text-muted-foreground">
              Content for “{title}” will appear here.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
