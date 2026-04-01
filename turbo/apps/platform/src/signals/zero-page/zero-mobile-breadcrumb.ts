import { computed } from "ccstate";
import type { RoutePath } from "../../types/route.ts";
import { pathParams$ } from "../route.ts";
import { zeroActiveId$, chatThreadId$ } from "./zero-nav.ts";
import { agents$ } from "./agents-list.ts";
import { agentDisplayName$, defaultAgentId$ } from "./zero-agent-name.ts";
import { zeroChatAgentId$ } from "./zero-active-agent.ts";
import { allOrgScheduleEntries$ } from "./zero-schedule.ts";
import { zeroActivityDetail$ } from "../../signals/activity-page/activity-signals.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { FeatureSwitchKey } from "@vm0/core";

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

const SCHEDULE_DETAIL_TITLE_MAX = 30;

function excerptText(text: string, maxLen: number): string {
  const t = text.trim();
  if (t.length <= maxLen) {
    return t;
  }
  return `${t.slice(0, maxLen - 1)}\u2026`;
}

function firstSentenceFromInstruction(text: string): string {
  const t = text.trim();
  if (t.length === 0) {
    return "";
  }
  const match = t.match(/^[\s\S]*?(?:[。！？]|[.!?](?:\s|$))/);
  if (match) {
    return match[0].trim();
  }
  return t.split(/\r?\n/)[0]?.trim() ?? t;
}

function scheduleEntryLabel(entry: {
  description: string | null;
  prompt: string;
  name: string;
}): string {
  const desc = entry.description?.trim();
  if (desc && desc.length > 0) {
    return excerptText(desc, SCHEDULE_DETAIL_TITLE_MAX);
  }
  const promptTrim = entry.prompt.trim();
  if (promptTrim.length > 0) {
    const first = firstSentenceFromInstruction(promptTrim);
    const label = first.length > 0 ? first : promptTrim;
    return excerptText(label, SCHEDULE_DETAIL_TITLE_MAX);
  }
  if (entry.name.trim().length > 0) {
    return entry.name.trim();
  }
  return "Schedule";
}

const teamDetailBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb> => {
    const params = get(pathParams$) as Params;
    const agentId = getStringParam(params, "agentId");
    if (agentId) {
      const agentsList = await get(agents$);
      const agent = agentsList.find((a) => {
        return a.id === agentId;
      });
      if (agent) {
        return {
          section: "Agents",
          sectionPath: "/team" as RoutePath,
          name: agent.displayName ?? undefined,
        };
      }
    }
    return { section: "Agents", sectionPath: "/team" as RoutePath };
  },
);

const activityDetailBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb | null> => {
    const features = await get(featureSwitch$);
    if (!features?.[FeatureSwitchKey.ActivityLogList]) {
      return null;
    }
    const params = get(pathParams$) as Params;
    const runId = getStringParam(params, "runId");
    if (runId) {
      const detail = await get(zeroActivityDetail$);
      if (detail && detail.id === runId) {
        return {
          section: "Activity logs",
          sectionPath: "/activity" as RoutePath,
          name: detail.displayName ?? undefined,
        };
      }
    }
    return { section: "Activity logs", sectionPath: "/activity" as RoutePath };
  },
);

/**
 * Provides breadcrumb data for the MobileTopBar.
 * For chat: resolves the active agent name and avatar.
 * For schedule/activity/team detail pages: derives a sub-page name from signals.
 * For other sections: returns a static label so the top bar has context on mobile
 * (page-level breadcrumbs use `hidden md:flex` and are invisible on mobile).
 */
export const mobileBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb | null> => {
    const activeId = get(zeroActiveId$);
    const params = get(pathParams$) as Params;

    if (activeId === "schedule") {
      const scheduleId = getStringParam(params, "scheduleId");
      if (scheduleId) {
        const entries = get(allOrgScheduleEntries$);
        const entry = entries.find((e) => {
          return e.id === scheduleId;
        });
        if (entry) {
          return {
            section: "Scheduled",
            sectionPath: "/schedule" as RoutePath,
            name: scheduleEntryLabel(entry),
          };
        }
      }
      return { section: "Scheduled", sectionPath: "/schedule" as RoutePath };
    }

    if (activeId === "team") {
      return await get(teamDetailBreadcrumb$);
    }

    if (activeId === "activity") {
      return await get(activityDetailBreadcrumb$);
    }

    // Static labels for other non-chat sections
    const nonChatSections: Partial<
      Record<string, { label: string; path: RoutePath }>
    > = {
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
