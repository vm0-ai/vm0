import { computed } from "ccstate";
import type { RoutePath } from "../../types/route.ts";
import { pathParams$ } from "../route.ts";
import { zeroActiveId$ } from "./zero-nav.ts";
import { agents$ } from "./agents-list.ts";
import { allOrgScheduleEntries$ } from "./zero-schedule.ts";

interface MobileBreadcrumb {
  section: string;
  sectionPath: RoutePath;
  name?: string;
}

type SectionEntry = { section: string; sectionPath: RoutePath };

function getSectionInfo(activeId: string): SectionEntry | null {
  const entries: Record<string, SectionEntry> = {
    team: { section: "Agents", sectionPath: "/team" },
    schedule: { section: "Scheduled", sectionPath: "/schedule" },
    activity: { section: "Activity", sectionPath: "/activity" },
    works: { section: "Works", sectionPath: "/works" },
    usage: { section: "Usage", sectionPath: "/usage" },
    preferences: { section: "Preferences", sectionPath: "/preferences" },
    queue: { section: "Queue", sectionPath: "/queue" },
    connectors: { section: "Connectors", sectionPath: "/connectors" },
  };
  return entries[activeId] ?? null;
}

export const mobileBreadcrumb$ = computed(
  async (get): Promise<MobileBreadcrumb | null> => {
    const activeId = get(zeroActiveId$);
    const params = get(pathParams$);
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

    return sectionInfo;
  },
);
