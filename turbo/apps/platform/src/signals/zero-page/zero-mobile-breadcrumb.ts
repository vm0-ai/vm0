import { computed } from "ccstate";
import type { RoutePath } from "../../types/route.ts";
import { ROUTES } from "../route-paths.ts";
import { pathParams$ } from "../route.ts";
import { activeRoute$ } from "../active-route.ts";
import { agents$, defaultAgentId$ } from "../agent.ts";
import {
  currentChatAgentId$,
  currentChatThreadId$,
  currentChatAgentDisplayName$,
} from "../agent-chat.ts";
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
          sectionPath: ROUTES.agents,
          name: agent.displayName ?? undefined,
        };
      }
    }
    return { section: "Agents", sectionPath: ROUTES.agents };
  },
);

const activityDetailBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb | null> => {
    const features = await get(featureSwitch$);
    if (!features?.[FeatureSwitchKey.ActivityLogList]) {
      return null;
    }
    const params = get(pathParams$) as Params;
    const activityRunId = getStringParam(params, "activityRunId");
    if (activityRunId) {
      const detail = await get(zeroActivityDetail$);
      if (detail && detail.id === activityRunId) {
        return {
          section: "Activity logs",
          sectionPath: ROUTES.activities,
          name: detail.displayName ?? undefined,
        };
      }
    }
    return { section: "Activity logs", sectionPath: ROUTES.activities };
  },
);

const scheduleBreadcrumb$ = computed((get): MobileBreadcrumb => {
  const params = get(pathParams$) as Params;
  const scheduleId = getStringParam(params, "scheduleId");
  if (scheduleId) {
    const entries = get(allOrgScheduleEntries$);
    const entry = entries.find((e) => {
      return e.id === scheduleId;
    });
    if (entry) {
      return {
        section: "Scheduled",
        sectionPath: ROUTES.schedules,
        name: scheduleEntryLabel(entry),
      };
    }
  }
  return { section: "Scheduled", sectionPath: ROUTES.schedules };
});

const chatBreadcrumb$ = computed(async (get): Promise<MobileBreadcrumb> => {
  const params = get(pathParams$) as Params;
  const displayName = await get(currentChatAgentDisplayName$);
  const defaultId = await get(defaultAgentId$);
  const threadId = get(currentChatThreadId$);
  const urlAgentId = getStringParam(params, "agentId");

  if (threadId !== null || urlAgentId !== null) {
    const subagentId = await get(currentChatAgentId$);
    if (subagentId) {
      const agentsList = await get(agents$);
      const subagent = agentsList.find((a) => {
        return a.id === subagentId;
      });
      return {
        section: subagent?.displayName ?? displayName ?? "Zero",
        sectionPath: CHAT_PATH,
        avatarAgentId: subagentId,
      };
    }
  }

  return {
    section: displayName ?? "Zero",
    sectionPath: CHAT_PATH,
    avatarAgentId: defaultId ?? undefined,
  };
});

/**
 * Provides breadcrumb data for the MobileTopBar.
 * For chat: resolves the active agent name and avatar.
 * For schedule/activity/team detail pages: derives a sub-page name from signals.
 * For other sections: returns a static label so the top bar has context on mobile
 * (page-level breadcrumbs use `hidden md:flex` and are invisible on mobile).
 */
export const mobileBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb | null> => {
    const route = get(activeRoute$);

    if (route === "schedules" || route === "scheduleDetail") {
      return await get(scheduleBreadcrumb$);
    }

    if (
      route === "agents" ||
      route === "agentDetail" ||
      route === "agentPermissions"
    ) {
      return await get(teamDetailBreadcrumb$);
    }

    if (route === "activities" || route === "activityDetail") {
      return await get(activityDetailBreadcrumb$);
    }

    // Static labels for other non-chat sections
    const nonChatSections: Partial<
      Record<string, { label: string; path: RoutePath }>
    > = {
      works: { label: "Works", path: ROUTES.works },
      settings: { label: "Settings", path: ROUTES.settings },
      queues: { label: "Queue", path: ROUTES.queues },
      connectors: { label: "Connectors", path: ROUTES.connectors },
    };
    if (route) {
      const nonChatSection = nonChatSections[route];
      if (nonChatSection) {
        return {
          section: nonChatSection.label,
          sectionPath: nonChatSection.path,
        };
      }
    }

    // Chat-related routes
    if (
      route !== "home" &&
      route !== "agentChat" &&
      route !== "agentIdeas" &&
      route !== "chat"
    ) {
      return null;
    }

    return await get(chatBreadcrumb$);
  },
);
