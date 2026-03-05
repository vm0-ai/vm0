import { useState, useCallback } from "react";
import { ZeroSidebar, type ZeroNavId } from "./zero-sidebar.tsx";
import { ZeroContent } from "./zero-content.tsx";

const RECENT_LABELS: Record<string, string> = {
  "1": "Daily digest workflow",
  "2": "Set up Slack integration",
  "3": "Weekly report automation",
  "4": "Code review reminders",
};

export function ZeroAppShell() {
  const [activeId, setActiveId] = useState<ZeroNavId>("chat");
  const [recentId, setRecentId] = useState<string | null>(null);

  const handleRecentSelect = useCallback((id: string) => {
    setRecentId(id);
    setActiveId("chat");
  }, []);

  const handleNavSelect = useCallback((id: ZeroNavId) => {
    setActiveId(id);
    setRecentId(null);
  }, []);

  const handleClearRecent = useCallback(() => {
    setRecentId(null);
  }, []);

  const recentLabel = recentId ? (RECENT_LABELS[recentId] ?? null) : null;

  return (
    <div className="flex h-dvh w-full bg-background">
      <ZeroSidebar
        activeId={activeId}
        onSelect={handleNavSelect}
        onRecentSelect={handleRecentSelect}
        selectedRecentId={activeId === "chat" ? recentId : null}
      />
      <div className="flex flex-1 flex-col min-w-0 zero-workspace-bg">
        <ZeroContent
          sectionId={activeId}
          recentLabel={recentLabel}
          recentId={recentId}
          onClearRecent={handleClearRecent}
          onNavigateToActivity={() => setActiveId("activity")}
        />
      </div>
    </div>
  );
}
