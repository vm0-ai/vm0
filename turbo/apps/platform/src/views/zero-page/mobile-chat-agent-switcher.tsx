import { useLastResolved, useResolved, useSet } from "ccstate-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { cn } from "@vm0/ui";
import {
  currentChatAgentId$,
  setChatAgentId$,
} from "../../signals/agent-chat.ts";
import { pinnedAgents$ } from "../../signals/zero-page/zero-pinned-agents.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
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

  if (!enabled) {
    return null;
  }

  return (
    <div
      className="md:hidden -mx-4 px-4 py-1.5 flex gap-4 overflow-x-auto snap-x"
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
            className="flex flex-col items-center gap-1.5 shrink-0 snap-start text-[12px] font-medium"
          >
            <span
              className={cn(
                "flex h-12 w-12 items-center justify-center rounded-full transition-colors",
                active ? "bg-gray-50" : "bg-transparent",
              )}
            >
              <AvatarFromUrl
                avatarUrl={agent.avatarUrl}
                alt=""
                className="block h-12 w-12 rounded-full object-cover object-top"
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
    </div>
  );
}
