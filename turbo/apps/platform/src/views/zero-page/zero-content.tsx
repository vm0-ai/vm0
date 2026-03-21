import type { ZeroNavId } from "./zero-sidebar.tsx";
import { ZeroChatPage } from "./zero-chat-page.tsx";
import { ZeroSessionChatPage } from "./zero-session-chat-page.tsx";
import { ZeroWorksPage } from "./zero-works-page.tsx";
import { ZeroSchedulePage } from "./zero-schedule-page.tsx";
import { ZeroSettingsPage } from "./zero-settings-page.tsx";
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
  onNavigateToMeet?: (tab?: string) => void;
  onBackFromSession?: () => void;
  zeroAvatarSrc?: string;
  /** Override agent name for the chat page when a sub-agent is selected. */
  chatAgentName?: string;
  /** Override avatar for the chat page when a sub-agent is selected. */
  chatAvatarSrc?: string;
  /** Navigate to agent profile — clicking chat header avatar. */
  onChatAvatarClick?: () => void;
}

export function ZeroContent({
  sectionId,
  inSession = false,
  onSendMessage,
  onNavigateToSchedule,
  onNavigateToMeet,
  onBackFromSession,
  zeroAvatarSrc = zeroAvatarImg,
  chatAgentName,
  chatAvatarSrc,
  onChatAvatarClick,
}: ZeroContentProps) {
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
        onAvatarClick={onChatAvatarClick}
      />
    );
  }
  if (sectionId === "schedule") {
    return <ZeroSchedulePage />;
  }
  if (sectionId === "works") {
    return <ZeroWorksPage />;
  }
  if (sectionId === "settings") {
    return <ZeroSettingsPage />;
  }
  return <ZeroNotFoundPage />;
}

function ZeroNotFoundPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center min-h-0 px-4">
      <h1 className="text-6xl font-bold text-muted-foreground/50">404</h1>
      <p className="mt-4 text-lg text-muted-foreground">
        The page you are looking for does not exist.
      </p>
      <a href="/" className="mt-6 text-sm text-primary hover:underline">
        Go to home
      </a>
    </div>
  );
}
