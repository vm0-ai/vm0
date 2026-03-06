import { useState, useCallback } from "react";
import {
  ZeroSidebar,
  type ZeroNavId,
  type ZeroAccountAction,
  type ZeroAccountSubId,
} from "./zero-sidebar.tsx";
import { ZeroContent } from "./zero-content.tsx";

const ZERO_AVATARS = [
  "/zero-avatar.png",
  "/avatars/avatar-1.png",
  "/avatars/avatar-2.png",
  "/avatars/avatar-3.png",
  "/avatars/avatar-4.png",
];

const RECENT_LABELS: Record<string, string> = {
  "1": "Daily digest workflow",
  "2": "Set up Slack integration",
  "3": "Weekly report automation",
  "4": "Code review reminders",
};

export function ZeroAppShell() {
  const [activeId, setActiveId] = useState<ZeroNavId>("chat");
  const [recentId, setRecentId] = useState<string | null>(null);
  const [accountSubId, setAccountSubId] = useState<ZeroAccountSubId>(null);
  const [avatarIndex, setAvatarIndex] = useState(0);
  const zeroAvatarSrc = ZERO_AVATARS[avatarIndex] ?? ZERO_AVATARS[0];
  const cycleAvatar = useCallback(() => {
    setAvatarIndex((i) => (i + 1) % ZERO_AVATARS.length);
  }, []);

  const handleRecentSelect = useCallback((id: string) => {
    setRecentId(id);
    setActiveId("chat");
  }, []);

  const handleNavSelect = useCallback((id: ZeroNavId) => {
    setActiveId(id);
    setRecentId(null);
  }, []);

  const handleAccountAction = useCallback((action: ZeroAccountAction) => {
    if (action === "signout") {
      setAccountSubId(null);
      setActiveId("chat");
    } else {
      setActiveId("account");
      setAccountSubId(action);
    }
  }, []);

  const handleClearRecent = useCallback(() => {
    setRecentId(null);
  }, []);

  const recentLabel = recentId ? (RECENT_LABELS[recentId] ?? null) : null;

  return (
    <div className="zero-app flex h-dvh w-full bg-background">
      <ZeroSidebar
        activeId={activeId}
        onSelect={handleNavSelect}
        onRecentSelect={handleRecentSelect}
        selectedRecentId={activeId === "chat" ? recentId : null}
        zeroAvatarSrc={zeroAvatarSrc}
        onAvatarClick={cycleAvatar}
        onAccountAction={handleAccountAction}
      />
      <div className="flex flex-1 flex-col min-w-0 zero-workspace-bg">
        <ZeroContent
          sectionId={activeId}
          accountSubId={accountSubId}
          recentLabel={recentLabel}
          recentId={recentId}
          onClearRecent={handleClearRecent}
          onNavigateToActivity={() => setActiveId("activity")}
          onNavigateToSchedule={() => setActiveId("schedule")}
          onNavigateToJob={() => setActiveId("job")}
          zeroAvatarSrc={zeroAvatarSrc}
          onAvatarClick={cycleAvatar}
        />
      </div>
    </div>
  );
}
