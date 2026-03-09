import { useState, useCallback } from "react";
import {
  ZeroSidebar,
  type ZeroNavId,
  type ZeroAccountAction,
  type ZeroAccountSubId,
} from "./zero-sidebar.tsx";
import { Button } from "@vm0/ui";
import { ZeroAboutPage } from "./zero-about-page.tsx";
import { ZeroContent } from "./zero-content.tsx";
import { ZeroOnboarding } from "./zero-onboarding.tsx";

const ZERO_AVATARS = [
  "/zero-avatar.png",
  "/avatars/avatar-1.png",
  "/avatars/avatar-2.png",
  "/avatars/avatar-3.png",
  "/avatars/avatar-4.png",
];

const RECENT_LABELS: Record<string, string> = {
  hello: "Hello from Zero",
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
  const [showAboutPage, setShowAboutPage] = useState(false);
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
    setShowAboutPage(false);
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
      <ZeroOnboarding
        zeroAvatarSrc={zeroAvatarSrc}
        onAvatarClick={cycleAvatar}
      />
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
        <nav
          className="pointer-events-none absolute right-6 top-6 z-10"
          aria-label="Site links"
        >
          <div className="zero-float-card pointer-events-auto flex items-center gap-4 rounded-xl border border-border bg-card/95 px-4 py-2.5 backdrop-blur-sm">
            <button
              type="button"
              onClick={() => setShowAboutPage(true)}
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
              <Button
                size="sm"
                className="h-9 rounded-lg px-4 text-sm font-medium"
              >
                Sign in
              </Button>
            </a>
          </div>
        </nav>
        {showAboutPage ? (
          <ZeroAboutPage onBack={() => setShowAboutPage(false)} />
        ) : (
          <ZeroContent
            sectionId={activeId}
            accountSubId={accountSubId}
            recentLabel={recentLabel}
            recentId={recentId}
            onClearRecent={handleClearRecent}
            onNavigateToActivity={() => setActiveId("activity")}
            onNavigateToSchedule={() => setActiveId("schedule")}
            onNavigateToJob={() => setActiveId("job")}
            onNavigateToChat={() => setActiveId("chat")}
            zeroAvatarSrc={zeroAvatarSrc}
            onAvatarClick={cycleAvatar}
          />
        )}
      </div>
    </div>
  );
}
