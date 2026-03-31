import { computed } from "ccstate";
import type { RoutePath } from "../../types/route.ts";
import { pathParams$ } from "../route.ts";
import { zeroActiveId$, chatThreadId$ } from "./zero-nav.ts";
import { agents$ } from "./agents-list.ts";
import { allOrgScheduleEntries$ } from "./zero-schedule.ts";
import { agentDisplayName$, defaultAgentId$ } from "./zero-agent-name.ts";
import { zeroChatAgentId$ } from "./zero-active-agent.ts";

interface MobileBreadcrumb {
  section: string;
  sectionPath: RoutePath;
  name?: string;
  description?: string;
  avatarAgentId?: string;
}

type SectionEntry = {
  section: string;
  sectionPath: RoutePath;
  description?: string;
};

function getSectionInfo(activeId: string): SectionEntry | null {
  const entries: Record<string, SectionEntry> = {
    team: { section: "Agents", sectionPath: "/team" },
    schedule: {
      section: "Scheduled",
      sectionPath: "/schedule",
      description: "Automated tasks across all agents",
    },
    activity: {
      section: "Activity",
      sectionPath: "/activity",
      description: "Logs and runs from your agents.",
    },
    works: { section: "Works", sectionPath: "/works" },
    usage: { section: "Usage", sectionPath: "/usage" },
    preferences: {
      section: "Preferences",
      sectionPath: "/preferences",
      description: "Appearance and runtime preferences",
    },
    queue: { section: "Queue", sectionPath: "/queue" },
    connectors: {
      section: "Connectors",
      sectionPath: "/connectors",
      description: "Connect third-party services for your agents.",
    },
  };
  return entries[activeId] ?? null;
}

export const mobileBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb | null> => {
    const activeId = get(zeroActiveId$);
    const params = get(pathParams$);

    // Chat session or /talk/:agentId — show avatar + agent name in top bar
    if (activeId === "chat") {
      const chatThreadId = get(chatThreadId$);
      const currentAgentId =
        params && "agentId" in params ? String(params.agentId) : null;
      if (chatThreadId !== null || currentAgentId !== null) {
        const subagentId = await get(zeroChatAgentId$);
        const displayName = await get(agentDisplayName$);
        if (subagentId) {
          const agentsList = await get(agents$);
          const subagent = agentsList.find((a) => a.id === subagentId);
          return {
            section: subagent?.displayName ?? displayName,
            sectionPath: "/" as RoutePath,
            avatarAgentId: subagentId,
          };
        }
        const defaultId = await get(defaultAgentId$);
        return {
          section: displayName,
          sectionPath: "/" as RoutePath,
          avatarAgentId: defaultId ?? undefined,
        };
      }
      // Landing page — show default agent avatar + name
      const displayName = await get(agentDisplayName$);
      const defaultId = await get(defaultAgentId$);
      return {
        section: displayName,
        sectionPath: "/" as RoutePath,
        avatarAgentId: defaultId ?? undefined,
      };
    }

    const sectionInfo = getSectionInfo(activeId);
    if (!sectionInfo) {
      return null;
    }

    if (activeId === "team" && params && "agentId" in params) {
      const agentId = String(params.agentId);
      const agentsList = await get(agents$);
      const agent = agentsList.find((a) => a.id === agentId);
      return { ...sectionInfo, name: agent?.displayName ?? undefined };
    }

    if (activeId === "schedule" && params && "scheduleId" in params) {
      const scheduleId = String(params.scheduleId);
      const entries = get(allOrgScheduleEntries$);
      const entry = entries.find((e) => e.id === scheduleId);
      const name =
        entry?.description?.trim() || entry?.name?.trim() || undefined;
      return { ...sectionInfo, name };
    }

    // Dynamic descriptions for team and works (include agent display name)
    if (activeId === "team" || activeId === "works") {
      const displayName = await get(agentDisplayName$);
      const description =
        activeId === "team"
          ? `${displayName} and sub-agents working together`
          : `Connect with ${displayName} through these channels`;
      return { ...sectionInfo, description };
    }

    return sectionInfo;
  },
);
