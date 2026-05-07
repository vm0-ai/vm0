import { useLastResolved, useResolved, useSet } from "ccstate-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { IconPlus } from "@tabler/icons-react";
import { cn } from "@vm0/ui";
import {
  currentChatAgentId$,
  setChatAgentId$,
} from "../../signals/agent-chat.ts";
import { pinnedAgents$ } from "../../signals/zero-page/zero-pinned-agents.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { setMobileNewSessionSheetOpen$ } from "../../signals/zero-page/zero-nav.ts";
import { AvatarFromUrl } from "./zero-sidebar-shared.tsx";

/**
 * Horizontal scroll strip of pinned agents shown above the chat list on
 * mobile. Tapping an avatar switches which agent's threads are showing.
 * Gated behind MobileNativeV1.
 */
export function MobileChatAgentSwitcher() {
  const features = useLastResolved(featureSwitch$);
  const enabled = features?.[FeatureSwitchKey.MobileNativeV1] ?? false;

  const pinned = useLastResolved(pinnedAgents$) ?? [];
  const currentId = useResolved(currentChatAgentId$);
  const setAgentId = useSet(setChatAgentId$);
  const openNewSession = useSet(setMobileNewSessionSheetOpen$);

  if (!enabled) {
    return null;
  }

  return (
    <div
      className="md:hidden -mx-4 px-4 py-2 flex gap-4 overflow-x-auto snap-x"
      data-testid="mobile-chat-agent-switcher"
      aria-label="Pinned teammates"
    >
      {pinned.map((agent) => {
        const active = currentId === agent.id;
        const label = agent.displayName ?? "Agent";
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => {
              setAgentId(agent.id);
            }}
            aria-pressed={active}
            aria-label={`Switch to ${label}`}
            data-testid={`mobile-chat-agent-${agent.id}`}
            className="flex flex-col items-center gap-1 shrink-0 snap-start text-[13px] font-medium"
          >
            <span
              className={cn(
                "flex h-12 w-12 items-center justify-center rounded-xl transition-colors",
                active ? "bg-muted ring-1 ring-border" : "bg-transparent",
              )}
            >
              <AvatarFromUrl
                avatarUrl={agent.avatarUrl}
                alt=""
                className="block h-11 w-11 rounded-xl object-cover object-top"
              />
            </span>
            <span
              className={cn(
                "max-w-[64px] truncate",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {label}
            </span>
          </button>
        );
      })}
      {/* Trailing "+" chip — opens the agent picker sheet so the user can
          start a new chat with any agent without leaving the strip. */}
      <button
        type="button"
        onClick={() => {
          openNewSession(true);
        }}
        aria-label="Start a new chat with another agent"
        data-testid="mobile-new-session-chip"
        className="flex flex-col items-center gap-1 shrink-0 snap-start text-[13px] font-medium"
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/60 ring-1 ring-border text-muted-foreground">
          <IconPlus size={22} stroke={1.8} />
        </span>
        <span className="max-w-[64px] truncate text-muted-foreground">
          New
        </span>
      </button>
    </div>
  );
}
