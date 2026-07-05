import { computed } from "ccstate";
import type { RoutePath } from "../../types/route.ts";
import { isWorkflowDetailRouteKey, ROUTES } from "../route-paths.ts";
import { pathParams$, type RouterPathParams } from "../route.ts";
import { activeRoute$ } from "../active-route.ts";
import { agents$, defaultAgentId$ } from "../agent.ts";
import {
  currentChatAgentId$,
  currentChatThreadId$,
  currentChatAgentDisplayName$,
} from "../agent-chat.ts";
import { zeroActivityDetail$ } from "../../signals/activity-page/activity-signals.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { workflowDetail } from "../workflows-page/workflows-signals.ts";

interface MobileBreadcrumb {
  section: string;
  sectionPath: RoutePath;
  sectionOptions?: {
    pathParams?: RouterPathParams;
    searchParams?: URLSearchParams;
  };
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
    if (!features?.[FeatureSwitchKey.ZeroDebug]) {
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

const workflowsBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb> => {
    const section = "Workflows";
    const params = get(pathParams$) as Params;
    const workflowId = getStringParam(params, "workflowId");
    if (workflowId) {
      const detail = await get(workflowDetail(workflowId));
      if (detail) {
        return {
          section,
          sectionPath: ROUTES.workflows,
          name: detail.displayName ?? detail.name,
        };
      }
    }
    return {
      section,
      sectionPath: ROUTES.workflows,
    };
  },
);

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
 * For automation/activity/team detail pages: derives a sub-page name from signals.
 * For other sections: returns a static label so the top bar has context on mobile
 * (page-level breadcrumbs use `hidden md:flex` and are invisible on mobile).
 */
export const mobileBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb | null> => {
    const route = get(activeRoute$);

    if (route === "workflows" || isWorkflowDetailRouteKey(route)) {
      return await get(workflowsBreadcrumb$);
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

    if (route === "works") {
      const displayName = await get(currentChatAgentDisplayName$);
      return {
        section: `Where ${displayName ?? "Zero"} works`,
        sectionPath: ROUTES.works,
      };
    }

    // Static labels for other non-chat sections
    const nonChatSections: Partial<
      Record<string, { label: string; path: RoutePath }>
    > = {
      settings: { label: "Settings", path: ROUTES.settings },
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
