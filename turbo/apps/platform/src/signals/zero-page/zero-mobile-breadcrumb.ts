import { computed } from "ccstate";
import type { RoutePath } from "../../types/route.ts";
import { pathParams$ } from "../route.ts";
import { zeroActiveId$, chatThreadId$ } from "./zero-nav.ts";
import { agents$ } from "./agents-list.ts";
import { agentDisplayName$, defaultAgentId$ } from "./zero-agent-name.ts";
import { zeroChatAgentId$ } from "./zero-active-agent.ts";

interface MobileBreadcrumb {
  section: string;
  sectionPath: RoutePath;
  name?: string;
  avatarAgentId?: string;
}

type Params = Record<string, unknown> | null;

function getStringParam(params: Params, key: string): string | null {
  if (params && key in params) {
    return String(params[key]);
  }
  return null;
}

const CHAT_PATH = "/" as RoutePath;

/**
 * Provides breadcrumb data for the MobileTopBar.
 * For chat: resolves the active agent name and avatar.
 * For other sections: returns a static label so the top bar has context on mobile
 * (page-level breadcrumbs use `hidden md:flex` and are invisible on mobile).
 */
export const mobileBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb | null> => {
    const activeId = get(zeroActiveId$);

    // Static labels for non-chat sections
    const nonChatSections: Partial<
      Record<string, { label: string; path: RoutePath }>
    > = {
      schedule: { label: "Scheduled", path: "/schedule" as RoutePath },
      team: { label: "Agents", path: "/team" as RoutePath },
      activity: { label: "Activity logs", path: "/activity" as RoutePath },
      works: { label: "Works", path: "/works" as RoutePath },
      usage: { label: "Usage", path: "/usage" as RoutePath },
      preferences: { label: "Preferences", path: "/preferences" as RoutePath },
      queue: { label: "Queue", path: "/queue" as RoutePath },
      connectors: { label: "Connectors", path: "/connectors" as RoutePath },
    };
    const nonChatSection = nonChatSections[activeId];
    if (nonChatSection) {
      return {
        section: nonChatSection.label,
        sectionPath: nonChatSection.path,
      };
    }

    if (activeId !== "chat") {
      return null;
    }

    const params = get(pathParams$) as Params;
    const displayName = await get(agentDisplayName$);
    const defaultId = await get(defaultAgentId$);
    const chatThreadId = get(chatThreadId$);
    const urlAgentId = getStringParam(params, "agentId");

    if (chatThreadId !== null || urlAgentId !== null) {
      const subagentId = await get(zeroChatAgentId$);
      if (subagentId) {
        const agentsList = await get(agents$);
        const subagent = agentsList.find((a) => {
          return a.id === subagentId;
        });
        return {
          section: subagent?.displayName ?? displayName,
          sectionPath: CHAT_PATH,
          avatarAgentId: subagentId,
        };
      }
    }

    // Landing page or session without sub-agent — show default agent
    return {
      section: displayName,
      sectionPath: CHAT_PATH,
      avatarAgentId: defaultId ?? undefined,
    };
  },
);
