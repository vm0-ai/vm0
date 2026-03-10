import { useCCState, useCommand } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
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
import { user$ } from "../../signals/auth.ts";

const ZERO_AVATARS = [
  "/zero-avatar.png",
  "/avatars/avatar-1.png",
  "/avatars/avatar-2.png",
  "/avatars/avatar-3.png",
  "/avatars/avatar-4.png",
] as const;

const RECENT_LABELS: Readonly<Record<string, string>> = {
  hello: "Hello from Zero",
  "1": "Daily digest workflow",
  "2": "Set up Slack integration",
  "3": "Weekly report automation",
  "4": "Code review reminders",
};

const showOnboarding = false;

export function ZeroAppShell() {
  const userLoadable = useLoadable(user$);
  const isLoggedIn =
    userLoadable.state === "hasData" && userLoadable.data !== undefined;
  const activeId$ = useCCState<ZeroNavId>("chat");
  const activeId = useGet(activeId$);
  const setActiveId = useSet(activeId$);
  const recentId$ = useCCState<string | null>(null);
  const recentId = useGet(recentId$);
  const accountSubId$ = useCCState<ZeroAccountSubId>(null);
  const accountSubId = useGet(accountSubId$);
  const avatarIndex$ = useCCState(0);
  const avatarIndex = useGet(avatarIndex$);
  const showAboutPage$ = useCCState(false);
  const showAboutPage = useGet(showAboutPage$);
  const setShowAboutPage = useSet(showAboutPage$);
  const zeroAvatarSrc = ZERO_AVATARS[avatarIndex] ?? ZERO_AVATARS[0];
  const cycleAvatar$ = useCommand(({ set }) => {
    set(avatarIndex$, (i: number) => (i + 1) % ZERO_AVATARS.length);
  });
  const cycleAvatar = useSet(cycleAvatar$);

  const handleRecentSelect$ = useCommand(({ set }, id: string) => {
    set(recentId$, id);
    set(activeId$, "chat" as ZeroNavId);
  });
  const handleRecentSelect = useSet(handleRecentSelect$);

  const handleNavSelect$ = useCommand(({ set }, id: ZeroNavId) => {
    set(activeId$, id);
    set(recentId$, null);
    set(showAboutPage$, false);
  });
  const handleNavSelect = useSet(handleNavSelect$);

  const handleAccountAction$ = useCommand(
    ({ set }, action: ZeroAccountAction) => {
      if (action === "signout" || action === "manage") {
        return;
      }
      set(activeId$, "account" as ZeroNavId);
      set(accountSubId$, action as ZeroAccountSubId);
    },
  );
  const handleAccountAction = useSet(handleAccountAction$);

  const handleClearRecent$ = useCommand(({ set }) => {
    set(recentId$, null);
  });
  const handleClearRecent = useSet(handleClearRecent$);

  const recentLabel = recentId ? (RECENT_LABELS[recentId] ?? null) : null;

  return (
    <div className="zero-app flex h-dvh w-full bg-background">
      {/* TODO: re-enable onboarding when ready */}
      {showOnboarding && (
        <ZeroOnboarding
          zeroAvatarSrc={zeroAvatarSrc}
          onAvatarClick={cycleAvatar}
        />
      )}
      <ZeroSidebar
        activeId={activeId}
        onSelect={handleNavSelect}
        onRecentSelect={handleRecentSelect}
        selectedRecentId={activeId === "chat" ? recentId : null}
        onAccountAction={handleAccountAction}
      />
      <div className="flex flex-1 flex-col min-w-0 zero-workspace-bg">
        {!isLoggedIn && (
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
        )}
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
